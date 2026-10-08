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
- A Codexify build containing the ChatGPT backend/controller and rich tool-preview support from
  `thesunwave/codexify`, pinned commit `e14c5a353a4af842a0751c8e943a5977a0ccd304`.
- A ChatGPT conversation connected to that Codexify instance and attached as a long-lived backend.
- A workspace that the Codexify service user can access.

The current alpha has only been exercised on macOS. The provider talks to Codexify through a local Unix-domain socket, so Windows is not currently a supported target.

## Install

See [docs/INSTALL.md](docs/INSTALL.md) for the full setup.

Run the conservative macOS installer:

```sh
git clone --branch v0.1.0-alpha.1 --depth 1 https://github.com/thesunwave/paseo-chatgpt-provider.git
cd paseo-chatgpt-provider
./install.sh --dry-run
./install.sh
```

The installer pins the Codexify revision and preserves running services and
existing configuration. You must still connect ChatGPT to Codexify and attach
one dedicated backend conversation. Use `./install.sh --check` to diagnose or
`./install.sh --uninstall` to remove only the installed Paseo plugin.

If Codexify is already configured, install the provider directly from Git:

```sh
paseo plugin add git:thesunwave/paseo-chatgpt-provider --ref v0.1.0-alpha.1
```

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

- publish or upstream a compatible Codexify build so users do not have to build the prototype branch manually;
- define/test Linux support, or explicitly keep the first release macOS-only;
- bound or compact very long persisted timelines if large conversations become a practical issue.

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
