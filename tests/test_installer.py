import json
import os
import socket
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALL = ROOT / "install.sh"
MERGE = ROOT / "scripts" / "merge-codexify-config.py"


class ReplySocket:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.bind(str(path))
        self.sock.listen()
        self.sock.settimeout(0.1)
        self.stop = False
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stop:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                conn.recv(65536)
                conn.sendall(b'{"ok":true,"result":{"available_capacity":1}}\n')

    def close(self):
        self.stop = True
        self.sock.close()
        self.thread.join(timeout=2)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        # The macOS-only shell guard can be tested in CI on Linux with a fake uname.
        (self.bin / "uname").write_text("#!/bin/sh\necho Darwin\n")
        (self.bin / "paseo").write_text(
            "#!/bin/sh\n"
            'echo "$*" >>"$MOCK_PASEO_LOG"\n'
            'if [ "$1" = plugin ] && [ "$2" = ls ]; then\n'
            '  if [ -f "$MOCK_PASEO_PRESENT" ]; then echo chatgpt-codexify; exit 0; fi\n'
            "  exit 1\nfi\n"
            'if [ "$1" = plugin ] && [ "$2" = install ]; then touch "$MOCK_PASEO_PRESENT"; fi\n'
            'if [ "$1" = plugin ] && [ "$2" = remove ]; then rm -f "$MOCK_PASEO_PRESENT"; fi\n'
        )
        for path in self.bin.iterdir():
            path.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "MOCK_PASEO_LOG": str(self.base / "paseo.log"),
            "MOCK_PASEO_PRESENT": str(self.base / "present"),
            "PASEO_CHATGPT_STATE_DIR": str(self.base / "state"),
            "CODEXIFY_CONFIG": str(self.base / "config.json"),
            "CODEXIFY_CHATGPT_BACKEND_SOCKET": str(self.base / "controller.sock"),
            "PASEO_CHATGPT_WORKSPACE_ROOT": str(self.base / "workspaces"),
        }

    def call(self, *args):
        return subprocess.run(
            ["bash", str(INSTALL), *args],
            cwd=str(ROOT), env=self.env, capture_output=True, text=True,
        )

    def merge(self, *args):
        return subprocess.run(
            ["python3", str(MERGE), "--config", self.env["CODEXIFY_CONFIG"],
             "--socket", self.env["CODEXIFY_CHATGPT_BACKEND_SOCKET"],
             "--workspace-root", self.env["PASEO_CHATGPT_WORKSPACE_ROOT"],
             "--work-dir", str(self.base / "projects"), *args],
            capture_output=True, text=True,
        )

    def test_dry_run_and_check_do_not_write_files(self):
        self.assertEqual(self.call("--dry-run").returncode, 0)
        self.assertEqual(self.call("--check").returncode, 0)
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), ["bin", "paseo.log"])

    def test_merge_preserves_config_and_is_idempotent(self):
        config = Path(self.env["CODEXIFY_CONFIG"])
        config.write_text(json.dumps({
            "apiKey": "SECRET", "port": 4000, "experimental": {"claudeSkills": True}
        }))
        self.assertEqual(self.merge().returncode, 0)
        obj = json.loads(config.read_text())
        self.assertEqual(obj["apiKey"], "SECRET")
        self.assertEqual(obj["port"], 4000)
        self.assertIs(obj["experimental"]["claudeSkills"], True)
        self.assertIs(obj["experimental"]["chatgptBridge"], True)
        self.assertNotIn("chatgptBackendControllerAllowedUid", obj["experimental"])
        self.assertEqual(len(list(self.base.glob("config.json.bak.*"))), 1)
        self.assertEqual(self.merge().returncode, 0)
        self.assertEqual(len(list(self.base.glob("config.json.bak.*"))), 1)

    def test_merge_refuses_foreign_socket_without_modifying_config(self):
        config = Path(self.env["CODEXIFY_CONFIG"])
        config.write_text('{"experimental":{"chatgptBackendControllerSocket":"/elsewhere.sock"}}')
        before = config.read_bytes()
        result = self.merge()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config.read_bytes(), before)
        self.assertEqual(list(self.base.glob("config.json.bak.*")), [])

    def test_install_reuses_controller_is_repeatable_and_uninstalls_plugin_only(self):
        server = ReplySocket(self.base / "controller.sock")
        self.addCleanup(server.close)
        first = self.call("--yes")
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        self.assertEqual(self.call("--yes").returncode, 0)
        lines = (self.base / "paseo.log").read_text().splitlines()
        self.assertEqual(len([line for line in lines if line.startswith("plugin install ")]), 1)
        self.assertFalse((self.base / "config.json").exists())
        self.assertEqual(self.call("--uninstall", "--yes").returncode, 0)
        self.assertTrue((self.base / "controller.sock").exists())
        self.assertFalse((self.base / "state" / "installed-provider").exists())


if __name__ == "__main__":
    unittest.main()
