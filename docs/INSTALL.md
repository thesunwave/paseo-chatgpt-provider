# Installation

This guide describes the current **macOS alpha** setup. The provider itself is a Paseo plugin, but it depends on a Codexify build that includes the ChatGPT backend/controller prototype.

## 1. Prerequisites

You need:

- Paseo 0.9.2 or newer.
- Node.js/npm for development checks.
- Rust/Cargo to build the current Codexify prototype branch.
- ChatGPT with the Codexify connector configured.
- A local workspace accessible to the Codexify service user.

Paseo plugins are trusted, unsandboxed code. Install this plugin only on a Paseo daemon where you trust the repository and its future updates.

## 2. Build the compatible Codexify branch

The provider currently requires the rich-tool-details branch in the public Codexify fork. That branch is one commit on top of the ChatGPT backend prototype and includes the bounded/redacted request/result previews used by Paseo tool cards:

```sh
git clone https://github.com/thesunwave/codexify.git
cd codexify
git checkout feat/paseo-rich-tool-details
cargo build --release
```

If you do not already have Codexify configured, run its guided setup from the same checkout:

```sh
cargo run --release -- quickstart
```

The important requirement is that the running Codexify binary comes from a branch containing the ChatGPT backend/controller support used by this provider.

## 3. Configure the ChatGPT backend controller

In `codexify.config.json`, enable the bridge and controller.

A tested macOS configuration looks like this:

```json
{
  "multiProject": true,
  "workDir": "/Users/your-codexify-user/projects",
  "experimental": {
    "chatgptBridge": true,
    "chatgptBackendControllerSocket": "/Users/Shared/codexify-chatgpt/backend.sock",
    "chatgptBackendControllerAllowedUid": 501,
    "chatgptBackendDelegatedRoots": [
      "/Users/Shared/PaseoWorkspaces"
    ]
  }
}
```

Adjust:

- `chatgptBackendControllerAllowedUid` to the UID of the user running the Paseo daemon/provider. On macOS:
  ```sh
  id -u
  ```
- `chatgptBackendDelegatedRoots` to the roots Paseo workspaces may use.
- `workDir` to your normal Codexify projects directory.

The provider defaults to the same socket used above:

```text
/Users/Shared/codexify-chatgpt/backend.sock
```

Advanced setups may override the provider socket with the Paseo daemon environment variable:

```sh
CODEXIFY_CHATGPT_BACKEND_SOCKET=/path/to/backend.sock
```

The Codexify controller and provider must point at the same socket.

## 4. Use a workspace both processes can access

If Paseo and Codexify run as the same macOS user, a normal project directory is usually sufficient.

If Codexify runs as a dedicated service user, a shared root is simpler:

```sh
sudo mkdir -p /Users/Shared/PaseoWorkspaces
sudo chgrp staff /Users/Shared/PaseoWorkspaces
sudo chmod 2775 /Users/Shared/PaseoWorkspaces
```

Put or clone Paseo projects under that root and include it in `chatgptBackendDelegatedRoots`.

Avoid using another user's `Documents` directory for the first setup. macOS TCC can deny a background/service user even when normal POSIX permissions look correct.

## 5. Start Codexify

Run the compatible Codexify build using your normal service setup, or keep it in the foreground while validating the alpha.

The controller socket should appear once the service is ready:

```sh
test -S /Users/Shared/codexify-chatgpt/backend.sock && echo "controller socket is present"
```

## 6. Attach a ChatGPT conversation as a backend

Open a dedicated ChatGPT conversation with the Codexify connector enabled.

Ask it to attach as a long-lived Paseo backend. For example:

> Attach this ChatGPT conversation as a long-lived coding backend for Paseo through Codexify. Call `chatgpt_backend_attach`, then stay in the `chatgpt_backend_exchange` loop until the backend receives `finish`.

Leave that ChatGPT conversation attached while using Paseo.

The provider does not create a ChatGPT backend by itself. It dispatches work to an already attached backend session.

## 7. Enable Paseo plugins

In Paseo:

1. Open **Settings → Plugins**.
2. Enable **Enable plugins** for the target daemon.

Paseo installs plugins per daemon, so make sure you are configuring the daemon that owns the workspace you will use.

## 8. Install the provider

For a local checkout:

```sh
git clone https://github.com/thesunwave/paseo-chatgpt-provider.git
cd paseo-chatgpt-provider
npm ci
npm run typecheck
npm test
paseo plugin install "$PWD"
```

For Git installation:

```sh
paseo plugin add thesunwave/paseo-chatgpt-provider --ref master
```

The repository is currently private. Git installation therefore requires repository access until it is made public.

Confirm the plugin is loaded:

```sh
paseo plugin ls
```

## 9. Use Attached ChatGPT

1. Open a Paseo workspace that Codexify can access.
2. Start a new agent chat.
3. Select **Attached ChatGPT**.
4. Send a task.

A simple smoke test is:

```text
Run git status --short --branch once, do not modify anything, and report the branch/status.
```

Expected behavior:

- the user message appears in the Paseo timeline;
- a Shell card appears for the command;
- command output appears in the same card;
- the assistant answer appears after the tool call;
- restarting Paseo and reopening the same chat restores the timeline.

## 10. Updating the plugin

Git-installed Paseo plugins can be checked and updated with:

```sh
paseo plugin update chatgpt-codexify --check
paseo plugin update chatgpt-codexify
```

For a directory install after editing source:

```sh
npm run typecheck
npm test
paseo plugin reload chatgpt-codexify
```

See `TROUBLESHOOTING.md` if the model is missing, dispatch reports no capacity, the controller socket cannot be reached, or workspace commands fail.
