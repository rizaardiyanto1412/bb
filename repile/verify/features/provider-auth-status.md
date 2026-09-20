# Provider auth status

Provider auth status lets a user see whether the Claude and Codex CLIs on the
bb host are signed in, from Settings (AI providers section) or from the
terminal, without ever revealing tokens or keys.

## Sub-features

- `status-http` reads both providers over `GET /auth/status`.
- `status-cli` reads both providers via `bb provider-auth status`.
- `status-cli-json` reads one provider as JSON for scripting.

## How to get to it (user POV)

- Open Settings → AI providers in the browser; each provider shows Signed
  in or Signed out with plan, email, and expiry details.
- Run `bb provider-auth status` in a terminal.
- Run `bb provider-auth status --provider codex --json` for machine output.

## Driving it with control-repile

Preconditions:

- A stack was started by `control-repile.mjs launch` in this run.
- The plugin is installed (`install-plugin`, proven by doctor).
- `REPILE_VERIFY_STATE` points at its `run.json`.

- **HTTP status.** Read both providers. Run `control-repile.mjs drive-auth`.
  `status-claude.json` and `status-codex.json` show HTTP 200 with
  `{ provider, loggedIn }` shapes; `status-after-*.json` re-read the same
  shapes after the flow steps.
- **CLI status.** Run the same command the user runs. `drive-auth` also runs
  `bb provider-auth status`; `cli-provider-auth-status.txt` shows exit 0 with
  both provider names and no secret material.
- **CLI JSON.** Run `drive-auth`; `cli-provider-auth-codex.txt` shows exit 0
  and parseable JSON with `provider: "codex"`.
- **Proof.** `drive-auth.json` records each check with pass and detail. The
  before/after status pair proves reads reflect real state transitions.

## Gotchas

- Status reads host credential files, redirected to scratch by the harness
  (`HOME`, `CODEX_HOME`). Reads outside a harness run see the real user
  credentials instead.
- macOS keychain Claude credentials remain visible read-only; a signed-in
  host reports `loggedIn: true` even in isolation. That is expected, not a
  leak: only `{ provider, state }` crosses the API.
- Status alone never proves a login works; pair it with the flow feature.
