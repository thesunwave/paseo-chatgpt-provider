# Paseo ChatGPT via Codexify

Use an attached ChatGPT conversation as a coding backend inside Paseo.

```text
Paseo
  -> chatgpt-codexify provider
  -> Codexify backend controller
  -> attached long-lived ChatGPT conversation
  -> Codexify project tools
  -> live tool timeline + result
  -> Paseo UI
```

## Status

**Alpha.** The integration is working end-to-end and has been tested with a real Paseo workspace, a real Codexify service, and a real attached ChatGPT conversation on macOS.

The current implementation supports:

- `Attached ChatGPT` as a Paseo model.
- Atomic dispatch to an available ChatGPT backend session.
- Workspace rebinding through Codexify delegated roots.
- Follow-up steering while a ChatGPT turn is active.
- Paseo interrupt/cancel handling with bounded recovery.
- Live tool-call timeline updates.
- Rich shell details: command, output, exit code, and normalized errors.
- Long-running shell processes folded into one card across `exec_command` / `write_stdin`.
- Durable provider-side timeline history across Paseo/provider/backend restarts.
- Recovery when an old Codexify backend session is stale or gone.

## Requirements

- Paseo `>= 0.9.2` with plugins enabled.
- **Recommended:** stock Codexify **v1.7.0** plus the standalone [Paseo Codexify sidecar](https://github.com/thesunwave/paseo-codexify-sidecar). The sidecar is an MCP proxy and controller, so no Codexify fork is needed.
- **Legacy:** our pinned Codexify fork `e14c5a353a4af842a0751c8e943a5977a0ccd304` is still compatible with this provider.
- A dedicated ChatGPT conversation attached to the backend, and a workspace accessible to the Codexify process.

The integration is macOS-tested. The provider communicates with the controller through a local Unix socket.

## Install (preferred: stock Codexify, no fork)

Follow the [sidecar installation guide](https://github.com/thesunwave/paseo-codexify-sidecar#installation) and run its installer, then attach ChatGPT through the sidecar MCP tools:

```sh
git clone --branch v0.2.0-alpha.1 --depth 1 https://github.com/thesunwave/paseo-codexify-sidecar.git
cd paseo-codexify-sidecar
./install.sh --dry-run
./install.sh
```

The provider can be installed independently with:

```sh
paseo plugin add git:thesunwave/paseo-chatgpt-provider --ref v0.2.0-alpha.1
```

The provider detects the new user-private sidecar socket automatically. `CODEXIFY_CHATGPT_BACKEND_SOCKET` continues to override the path; if neither is configured, the old `/Users/Shared/codexify-chatgpt/backend.sock` fallback remains.

The HTTPS tunnel/ChatGPT connector and dedicated ChatGPT backend attachment require user action. **Do not publish the local unauthenticated MCP proxy directly to the Internet.**

### Legacy Codexify fork

The original installer (`./install.sh` in this provider repository) remains available for existing fork-based installations; see [docs/INSTALL.md](docs/INSTALL.md). It builds our pinned Codexify branch and is not the recommended new-install path.

## Using it

1. Keep one ChatGPT conversation attached to Codexify as a Paseo backend.
2. Open a workspace in Paseo.
3. Select `Attached ChatGPT` from the model selector.
4. Send a coding task normally.

Paseo will show ChatGPT replies and tool activity in the same timeline. Persisted sessions restore their user messages, tool cards, and assistant replies after a Paseo restart.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

Useful first checks:

```sh
paseo plugin ls
paseo plugin logs chatgpt-codexify
test -S /Users/Shared/codexify-chatgpt/backend.sock && echo "controller socket is present"
```

## Distribution notes

The plugin itself can already be distributed directly from a Git repository; publishing to npm is not required by Paseo. `package.json` intentionally remains `private` while this is an alpha and while Git distribution is the primary path.

Before calling this a public beta, the remaining work is mostly compatibility and operational hardening:

- real ChatGPT connector/tunnel acceptance test for the new sidecar setup;
- clean-machine macOS install verification;
- Linux service packaging and policy checks;
- bounded long-history retention and credentials/sensitive-output redaction review.

See [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for the concrete alpha/beta checklist.

Licensed under [MIT](LICENSE).

## Development

```sh
npm ci
npm test
npm run typecheck
```

The plugin uses Paseo's runtime-provided SDK/libraries. Development dependencies are present for typechecking and tests.

## Relationship to Paseo Observatory

This project is separate from Paseo Observatory. Observatory monitors Paseo runs; this repository makes ChatGPT itself usable as a Paseo coding backend.
