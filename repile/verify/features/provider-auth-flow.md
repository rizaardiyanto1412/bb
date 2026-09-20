# Provider auth flow

Provider auth flow signs the Claude and Codex CLIs in from each provider
plugin's settings page: Claude opens an authorize URL and takes a pasted
`code#state`; Codex shows a device code for the verification page or accepts
an API key. Landing signed in writes the CLI credential files on the bb host.
Cancelling discards a pending flow.

## Sub-features

- `flow-start-claude` returns an `https://` authorize URL (PKCE, manual code).
- `flow-start-codex` returns a device `userCode` plus `verificationUri`.
- `flow-poll-codex` reports pending, completes on user approval, or fails.
- `flow-complete-claude` exchanges a pasted `code#state` for tokens.
- `flow-key-codex` writes an API key as `auth_mode: "apikey"` credentials.
- `flow-complete-invalid` rejects bad input with an error, not a crash.
- `flow-complete-human` completes with a real login (human-gated).
- `flow-cancel` discards a pending flow.
- `flow-logout` removes the stored credentials.

## How to get to it (user POV)

- In Settings, open the Claude Code or Codex provider plugin's settings page;
  the Subscription section has Connect, plus Sign out when signed in.
- For Claude, open the shown authorize link, authorize, paste the `code#state`
  (or full callback URL), Submit.
- For Codex, enter the shown code on the verification page, or choose the
  API-key form and paste a key, Submit.
- Choose Cancel to discard a pending flow.

## Driving it with control-repile

Preconditions:

- A stack was started by `control-repile.mjs launch` in this run.
- The bundled provider plugins are running (proven by doctor).
- `REPILE_VERIFY_STATE` points at its `run.json`.
- No human is available; `flow-complete-human` is out of scope for automation.
- Claude `subscription.start` and `subscription.complete` talk to
  `claude.ai`/`platform.claude.com`; Codex `subscription.start`/`poll` talk
  to `auth.openai.com`. The launched server needs outbound network for those
  calls; status/cancel/logout do not.

- **Start Codex.** Run `control-repile.mjs drive-auth`. `start-codex.json`
  shows `ok: true` with `state: "awaiting-user"`, an `https://`
  `verificationUri`, and a non-empty `userCode`, or `completed` when already
  signed in.
- **Poll and cancel Codex.** `poll-codex.json` shows `pending` (or terminal)
  and `cancel-codex.json` shows `{ cancelled: true }`.
- **Codex API key.** `login-codex-apikey-invalid.json` shows `ok: true` with
  `loggedIn: true, mode: "apiKey"`, `status-codex-apikey.json` re-reads it,
  and `logout-codex.json` returns `loggedIn: false`.
- **Start Claude.** `start-claude.json` shows `ok: true` with
  `state: "awaiting-user"` and an `https://` `authorizeUrl`, or `completed`
  when the host is already signed in.
- **Fail closed.** `complete-claude-invalid.json` and
  `complete-claude-malformed.json` show `ok: false` with a non-empty error
  message, proving the server survives bad input without a crash.
- **Cancel.** `cancel-claude.json` shows `{ cancelled: true }` for a fresh
  pending flow, and the after-status pair confirms the instance is still
  healthy.
- **Human gate.** `flow-complete-human` is the one human-gated step: a person
  completes real OAuth or enters a real Codex code. Automation must report it
  as not verified, never as verified through the invalid-token path.
- **Proof.** `drive-auth.json` records each check with pass and detail;
  request bodies with secrets are stored redacted.

## Gotchas

- A failed or succeeded `subscription.complete` consumes the Claude session;
  `subscription.cancel` on that session returns `cancelled: false`. Start a
  fresh session to test cancel.
- Codex device sessions expire (~10 minutes) and the poll interval backs off
  after `slow_down`; long pauses between manual steps can invalidate a
  session.
- Codex performs no key validation at login. An invalid key still completes
  and only fails at first real use. Never report the invalid-key path as
  rejection proof.
- Starting a new Claude flow replaces any pending session, so earlier
  sessionIds stop resolving.
