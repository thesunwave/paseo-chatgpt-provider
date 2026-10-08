#!/usr/bin/env python3
"""Safely enable the Paseo backend controller without discarding Codexify settings."""
import argparse
import json
import os
import shutil
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--config", required=True)
parser.add_argument("--socket", required=True)
parser.add_argument("--workspace-root", required=True)
parser.add_argument("--work-dir", required=True)
parser.add_argument("--allowed-uid", type=int)
args = parser.parse_args()

path = Path(args.config)
if path.is_symlink():
    parser.error("refusing symlinked config")
if path.exists() and not path.is_file():
    parser.error("config must be a regular file")
raw = path.read_bytes() if path.exists() else b""
config = json.loads(raw) if raw else {}
if not isinstance(config, dict):
    parser.error("config must be a JSON object")
exp = config.setdefault("experimental", {})
if not isinstance(exp, dict):
    parser.error("experimental config must be a JSON object")
if args.allowed_uid is None and exp.get("chatgptBackendControllerAllowedUid") is not None:
    parser.error("cross-user controller configuration requires manual setup")

# Never clobber a user's unrelated configuration. A mismatched controller UID/socket
# may belong to an existing service and must be investigated, not silently hijacked.
for key, expected in [
    ("chatgptBackendControllerSocket", args.socket),
]:
    old = exp.get(key)
    if old is not None and old != expected:
        parser.error(f"existing experimental.{key} differs; refusing to overwrite ({old!r})")

config.setdefault("schemaVersion", 1)
config.setdefault("workDir", args.work_dir)
config["multiProject"] = True
exp["chatgptBridge"] = True
exp["chatgptBackendControllerSocket"] = args.socket
if args.allowed_uid is not None:
    if exp.get("chatgptBackendControllerAllowedUid") not in (None, args.allowed_uid):
        parser.error("existing allowed UID differs; refusing to overwrite")
    exp["chatgptBackendControllerAllowedUid"] = args.allowed_uid
roots = exp.setdefault("chatgptBackendDelegatedRoots", [])
if not isinstance(roots, list) or any(not isinstance(x, str) for x in roots):
    parser.error("chatgptBackendDelegatedRoots must be an array of paths")
if args.workspace_root not in roots:
    roots.append(args.workspace_root)

rendered = (json.dumps(config, indent=2, ensure_ascii=False) + "\n").encode()
if rendered == raw:
    print(f"Config unchanged: {path}")
    raise SystemExit(0)
path.parent.mkdir(parents=True, exist_ok=True)
if raw:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.bak.{stamp}")
    i = 0
    while backup.exists():
        i += 1
        backup = path.with_name(f"{path.name}.bak.{stamp}.{i}")
    shutil.copy2(path, backup)
    print(f"Backup: {backup}")
fd, staged = tempfile.mkstemp(prefix=".codexify-config-", dir=path.parent)
try:
    mode = stat.S_IMODE(path.stat().st_mode) if raw else 0o600
    os.fchmod(fd, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(rendered)
        f.flush()
        os.fsync(f.fileno())
    os.replace(staged, path)
except BaseException:
    if os.path.exists(staged):
        os.unlink(staged)
    raise
print(f"Updated: {path}")
