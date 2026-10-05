# Troubleshooting

## Attached ChatGPT is missing from the model selector

Check that the plugin is enabled and loaded:

```sh
paseo plugin ls
paseo plugin logs chatgpt-codexify
```

If the plugin is disabled globally, enable plugins under **Settings → Plugins**.

If you installed a local directory after editing source, reload it:

```sh
paseo plugin reload chatgpt-codexify
```

## The provider reports no capacity / unavailable

The provider dispatches only to an already attached ChatGPT backend session.

Open the dedicated ChatGPT conversation connected to Codexify and attach it again:

> Attach this ChatGPT conversation as a long-lived coding backend for Paseo through Codexify. Call `chatgpt_backend_attach`, then stay in the `chatgpt_backend_exchange` loop until the backend receives `finish`.

If no backend is attached and waiting, Paseo has nowhere to send a task.

## The controller socket cannot be reached

The tested alpha configuration uses:

```text
/Users/Shared/codexify-chatgpt/backend.sock
```

Check that the socket exists:

```sh
ls -l /Users/Shared/codexify-chatgpt/backend.sock
test -S /Users/Shared/codexify-chatgpt/backend.sock && echo ok
```

Verify that Codexify and the provider use the same path.

Codexify config:

```json
{
  "experimental": {
    "chatgptBackendControllerSocket": "/Users/Shared/codexify-chatgpt/backend.sock"
  }
}
```

Provider override, if needed:

```sh
CODEXIFY_CHATGPT_BACKEND_SOCKET=/path/to/backend.sock
```

Remember that the override must be present in the environment of the Paseo daemon, not only in an unrelated terminal shell.

## Permission denied when the provider connects to the controller

The Codexify controller validates the UID of the connecting process.

Check the UID of the user running Paseo:

```sh
id -u
```

Use that value in:

```json
{
  "experimental": {
    "chatgptBackendControllerAllowedUid": 501
  }
}
```

Restart/reload Codexify after changing its config.

## Workspace command fails with Permission denied or Operation not permitted

First separate POSIX permissions from macOS privacy controls.

If Codexify runs as a dedicated user, make sure that user can traverse and read/write the workspace.

A tested layout is:

```text
/Users/Shared/PaseoWorkspaces/<project>
```

and the root is included in:

```json
{
  "experimental": {
    "chatgptBackendDelegatedRoots": [
      "/Users/Shared/PaseoWorkspaces"
    ]
  }
}
```

On macOS, another user's `Documents`, `Desktop`, and similar protected directories may still fail because of TCC even if `chmod`/ACLs look correct. Prefer a shared root for the alpha rather than granting broad Full Disk Access.

## A Shell card appears but details are empty

Use a provider revision that includes the tool-detail normalization work merged into `master`.

Check the installed revision:

```sh
paseo plugin ls chatgpt-codexify
```

Then update if needed:

```sh
paseo plugin update chatgpt-codexify --check
paseo plugin update chatgpt-codexify
```

## Long-running commands create separate write_stdin cards

This indicates an older provider build. Current `master` folds `exec_command` and subsequent `write_stdin` output into one Shell card.

Update or reload the plugin.

## History disappears after restarting Paseo

Current `master` persists provider timeline history in the Paseo session persistence payload.

The restored timeline should include:

- user messages;
- tool cards;
- assistant messages.

If history disappears:

1. confirm the installed plugin revision is current;
2. inspect `paseo plugin logs chatgpt-codexify`;
3. reproduce with a fresh chat and one simple tool call;
4. restart Paseo and reopen the exact same chat, not a new one.

Persistence from very old provider revisions does not contain timeline history. New history starts being durable once the session has emitted persistence v2.

## Git commands fail in a shared clone with .git/FETCH_HEAD permission denied

This is a repository ownership/permissions issue rather than a provider protocol issue.

For a shared checkout, ensure the Codexify user can write the repository metadata under `.git`, not only the working tree.

If the checkout was cloned by another user, either:

- fix group ownership/permissions for the whole repository including `.git`; or
- create the shared clone as the Codexify service user.

## The backend conversation stopped responding after a restart

The timeline can survive independently of the backend worker, but new work still needs a live attached backend.

Open or create a dedicated ChatGPT backend conversation and attach it again. The provider can bind the existing Paseo session to a new backend worker while retaining its provider-side timeline.

## Where to get logs

Provider logs:

```sh
paseo plugin logs chatgpt-codexify
```

Codexify service logs depend on how Codexify is supervised. If using its service CLI, inspect the service logs there as well.

For a minimal diagnostic report, capture:

```sh
paseo plugin ls
paseo plugin logs chatgpt-codexify --json
ls -l /Users/Shared/codexify-chatgpt/backend.sock
id -u
```

Do not paste secrets or Codexify tunnel credentials into bug reports.
