# Provider auth status

Provider auth status lets a user see whether the Claude and Codex CLI
credentials on the bb host are signed in, from each provider plugin's
settings page, without ever revealing tokens or keys.

## Sub-features

- `status-claude` reads sign-in state on the Claude Code provider settings.
- `status-codex` reads sign-in state on the Codex provider settings, including
  whether login is via ChatGPT account or API key.

## How to get to it (user POV)

- Open Settings, pick the Claude Code or Codex provider plugin; the
  Subscription section shows Signed in or Signed out with plan, email, and
  expiry details.

## Driving it with control-repile

Preconditions:

- A stack was started by `control-repile.mjs launch` in this run.
- The bundled provider plugins are running (proven by doctor).
- `REPILE_VERIFY_STATE` points at its `run.json`.

- **Status.** Read both providers. Run `control-repile.mjs drive-auth`.
  `status-claude.json` and `status-codex.json` show `ok: true` with a
  `{ loggedIn, ... }` result from `subscription.status`; the
  `status-after-*.json` artifacts re-read the same shapes after the flow
  steps.
- **Proof.** `drive-auth.json` records each check with pass and detail. The
  before/after status pair proves reads reflect real state transitions.

## Gotchas

- Status reads host credential files, redirected to scratch by the harness
  (`HOME`, `CODEX_HOME`). Reads outside a harness run see the real user
  credentials instead.
- macOS keychain Claude credentials remain visible read-only; a signed-in
  host reports `loggedIn: true` even in isolation. That is expected, not a
  leak: only the status fields cross the API.
- Status alone never proves a login works; pair it with the flow feature.
