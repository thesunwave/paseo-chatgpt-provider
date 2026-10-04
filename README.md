# Paseo ChatGPT via Codexify

Experimental Paseo provider that routes Paseo agent sessions into an attached ChatGPT conversation through Codexify.

## Prototype architecture

```text
Paseo
  -> chatgpt-codexify provider
  -> Codexify ChatGPT backend controller
  -> attached long-lived ChatGPT conversation
  -> Codexify project tools
  -> provider timeline/result events
  -> Paseo UI
```

The provider is intentionally separate from Paseo Observatory. Observatory monitors Paseo runs; this repository makes ChatGPT itself usable as a Paseo coding backend.

## What works

The current prototype has been exercised end-to-end with a real Paseo workspace and a real attached ChatGPT backend.

- Paseo exposes an `Attached ChatGPT` model.
- Fresh prompts are dispatched atomically to an available ChatGPT backend.
- A live backend can be rebound to a different delegated workspace.
- Long-lived Paseo sessions can recover from backend worker rotation.
- Follow-up prompts can steer an active ChatGPT turn.
- Paseo interrupt requests cancel or abandon stuck backend work safely.
- Backend tool lifecycle is streamed into Paseo as live tool-call timeline items.
- Backend pool state, drain lifecycle, stale detection, and bounded recovery are supported.
- Workspace delegation allows Paseo projects outside Codexify's primary `workDir`, when explicitly configured.

A real E2E smoke was verified against a shared checkout under:

```text
/Users/Shared/PaseoWorkspaces/telegram_history_bot
```

The full path worked across the two macOS users involved in the prototype: Paseo runs under the desktop user and Codexify runs under the dedicated `codexify` user.

## Current limitation

Paseo currently receives tool lifecycle metadata such as:

- tool name
- running/completed/failed state
- duration
- backend task/tool sequence IDs

It does **not** yet receive rich tool details such as command arguments, file paths, stdout/stderr, diffs, or result previews. The next useful increment is bounded and redacted tool request/result previews from Codexify, surfaced through the provider's `tool_call.detail` / metadata.

## Related Codexify work

The matching Codexify prototype lives in the `thesunwave/codexify` fork and contains the ChatGPT backend/controller, atomic dispatch, lifecycle hardening, workspace delegation, and tool-progress timeline support required by this provider.

This is a working prototype, not a production-ready integration.
