# Provider auth flow

Provider auth flow signs the Claude and Codex CLIs in from Settings: start a
login, open the authorize URL (Claude) or paste an API key (Codex), submit the
secret, and land signed in. Cancelling discards a pending flow.

## Sub-features

- `flow-start-claude` spawns `claude setup-token` and returns an authorize URL.
- `flow-start-codex` opens an API-key prompt (no URL) after probing the CLI.
- `flow-complete-invalid` rejects a bad token or key with a failed session.
- `flow-complete-human` completes with a real secret (human-gated).
- `flow-cancel` discards a pending flow and kills its process.

## How to get to it (user POV)

- In Settings → AI providers, choose Login under Claude or Codex.
- For Claude, open the shown link, authorize, paste the setup token, Submit.
- For Codex, paste an API key, Submit.
- Choose Cancel to discard a pending flow.

## Driving it with control-repile

Preconditions:

- A stack was started by `control-repile.mjs launch` in this run.
- The plugin is installed (`install-plugin`, proven by doctor).
- `REPILE_VERIFY_STATE` points at its `run.json`.
- No human is available; `flow-complete-human` is out of scope for automation.

- **Start Codex.** Open the API-key prompt path. Run
  `control-repile.mjs drive-auth`. `start-codex.json` shows HTTP 200 with
  `awaiting-user` and a null URL, or `completed` when already signed in.
- **Start Claude.** Open the authorize-URL path. `drive-auth` posts start for
  `claude`; `start-claude.json` shows HTTP 200 with `awaiting-user` and an
  `https://` URL, or `completed` when the host is already signed in.
- **Fail closed.** Submit a bad secret the way the form would. `drive-auth`
  posts an invalid token for `codex` (always) and for `claude` (when a flow
  is awaiting-user); the artifacts show HTTP 200 with `state: "failed"` and a
  non-empty error, proving the server survives bad input without a crash.
- **Cancel.** Discard both flows. `drive-auth` deletes both logins;
  `cancel-claude.json` and `cancel-codex.json` show `{ cancelled: true }`,
  and the after-status pair confirms the instance is still healthy.
- **Human gate.** `flow-complete-human` is the one human-gated step: a person
  opens the authorize URL, pastes a real token, and Submits. Automation must
  report it as not verified, never as verified through the invalid-token
  path.
- **Proof.** `drive-auth.json` records each check with pass and detail;
  request bodies with secrets are stored redacted.

## Gotchas

- Starting Claude spawns the real `claude` CLI with a 30s URL timeout; the
  process stays alive until complete or cancel. Always cancel after starting.
- `claude setup-token` needs a TTY and dies silent without one. The plugin
  runs it under a python pty driver on every platform and strips ANSI
  plus OSC-8 duplication before reading the URL.
- Codex performs no key validation at login. An invalid key still completes
  and a bad key only fails at first real use. Never report the invalid-key
  path as rejection proof.
- A `failed` session from a previous step does not block a new start; start
  replaces the stored session.
- Terminal sessions are pruned after 5 minutes and pending flows time out
  after 10; long pauses between manual steps can invalidate a session.
