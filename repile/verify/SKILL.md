---
name: verify-repile
description: "Drive Repile (bb web UI + server HTTP API + bb CLI) with control-repile.mjs: launch an isolated stack, check provider-auth login flows, and capture evidence. Use when verifying Repile provider login or plugin behavior."
---

# Verify Repile

Repile is verified through its real user surfaces: the Vite web UI (served with
`<title>Repile</title>`), the server HTTP API on loopback, and the `bb` CLI.
There is no browser CDP tool in this environment, so agents drive HTTP plus the
CLI. Every run uses a scratch data directory and free loopback ports, and never
touches the developer's own dev instance or `~/.bb`.

The helper `control-repile.mjs` in this directory is executable and owns the
whole loop. It resolves the repo root from its own path, so run it from anywhere
with `node`:

```sh
node repile/verify/control-repile.mjs launch
```

All commands except `launch` need the state file `launch` prints (or set
`REPILE_VERIFY_STATE`):

```sh
export REPILE_VERIFY_STATE=<proof-dir>/run.json
```

## Launch

Start one isolated stack:

```sh
node repile/verify/control-repile.mjs launch
```

Launch creates a scratch dir under the system temp dir with `data/`, `home/`,
and `codex-home/` inside it, picks three free loopback ports, and starts the
server from source (`apps/server/src/index.ts` via tsx) plus the Vite dev app.
It waits for `GET <server>/health` to return `{"ok": true}` and for
`GET <app>/` to serve `<title>Repile</title>`, then prints the App URL, Server
URL, data dir, state path, and proof dir.

Isolation model, enforced by the harness environment:

- `BB_DATA_DIR` points at the scratch `data/` dir. Nothing is written to the
  developer's dev data dir or `~/.bb`.
- `BB_SERVER_PORT`, `BB_HOST_DAEMON_PORT`, and `BB_DEV_APP_PORT` are free ports
  probed at launch, so the run never binds the developer's ports.
- `HOME` points at the scratch `home/` dir and `CODEX_HOME` at scratch
  `codex-home/`, so the provider-auth credential reads (`~/.claude/`,
  `~/.codex/auth.json`) and anything the `claude`/`codex` CLIs write stay inside
  scratch. Exception: macOS keychain Claude credentials are still visible
  read-only; if the host is signed in there, `start claude` returns
  `completed` instead of an authorize URL and the harness records that.
- Thread-context overrides (`BB_THREAD_ID`, `BB_ENVIRONMENT_ID`,
  `BB_THREAD_STORAGE`, `BB_PROJECT_ID`, `BB_CLI`) are stripped from every child.

Launch refuses to double-drive: if the ports it probed get taken before bind,
or the health/app checks time out (server 120s, app 180s), it fails with the
last observed status instead of falling back to any other instance. Never drive
an instance this run did not start; `doctor` is the check.

## Doctor

Read-only check. Run it first whenever anything looks off, and after install:

```sh
node repile/verify/control-repile.mjs doctor --state <run.json>
```

Doctor asserts three things and writes `doctor.json` plus
`doctor-plugin-list.json` to the proof dir:

1. `GET <server>/health` returns HTTP 200 with `ok: true`.
2. `GET <app>/` returns HTTP 200 containing `<title>Repile</title>`.
3. `bb plugin list --json` against the isolated server shows both bundled
   provider plugins, `provider-claude-code` and `provider-codex`.

Doctor fails if any check fails. A failed doctor means stop and investigate;
do not proceed to drive.

## Drive

Exercise the bundled provider subscription login without human OAuth:

```sh
node repile/verify/control-repile.mjs drive-auth --state <run.json>
```

Drive-auth performs the loopback plugin RPC calls a browser would make, using
the same `auth: "local"` semantics the SDK enforces (verified in
`packages/plugin-sdk/src/backend-contract.ts` and
`apps/server/src/browser-request-guard.ts`): loopback `Host`, no `Origin`
header, and `content-type: application/json` on every POST. Every call is
`POST /api/v1/plugins/<plugin-id>/rpc/<method>` with the input as the body
(`null` for no-arg methods) and replies are `{ ok: true, result }` or
`{ ok: false, error: { code, message } }`. The sequence:

- `provider-claude-code` `subscription.status` and `provider-codex`
  `subscription.status`, asserting `ok: true` and a boolean `loggedIn`.
- `provider-codex` `subscription.start`, asserting `awaiting-user` with an
  `https://` `verificationUri` and a non-empty `userCode`, or `completed`
  when already signed in. When awaiting, `subscription.poll` (pending or
  terminal) then `subscription.cancel` asserting `{ cancelled: true }`.
- `provider-codex` `subscription.loginApiKey` with an invalid key, asserting
  `ok: true` with `loggedIn: true, mode: "apiKey"` — Codex performs no key
  validation at login, so a bad key only fails at first real use. The write
  still proves the credential path; `subscription.status` re-read confirms
  it. Never report this as rejection proof.
- `provider-codex` `subscription.logout`, asserting `loggedIn: false`.
- `provider-claude-code` `subscription.start`, asserting `awaiting-user`
  with an `https://` `authorizeUrl`, or `completed` when already signed in.
- `subscription.complete` with an invalid code (only when a flow is
  awaiting-user), asserting `ok: false` with a non-empty error message: a
  graceful failure, not a crash. A failed complete consumes the session, so
  a fresh `subscription.start` precedes each subsequent step. A glued
  code+URL blob is rejected the same way.
- `subscription.cancel` on a fresh pending flow, asserting
  `{ cancelled: true }`, then `subscription.status` again for both plugins.

The feature map in `features/` names every entry point; `drive-auth` covers
the machine-verifiable ones. The one human-gated step (completing real OAuth)
is marked in `features/provider-auth-flow.md` and is never attempted.

## VPS target

The same flows run against the production VPS without touching local state:

```sh
node repile/verify/control-repile.mjs vps-doctor
node repile/verify/control-repile.mjs vps-drive-auth
```

`vps-doctor` asserts systemd units active, loopback 200 with the Repile
title, both provider plugins answering `subscription.status` over loopback
RPC, and public HTTPS returning 401. `vps-drive-auth` runs the Claude
start/invalid-complete/cancel and Codex device-start/poll/cancel over SSH
loopback curl and stores redacted evidence in its own proof dir. It never
submits real secrets and never restarts services. Prefer the local target
for iteration; use the VPS target to prove what is deployed.

## Evidence

Every command writes into the run proof dir `repile/verify/proof/<run-id>/`:

- `run.json`, `urls.txt`: launched URLs, ports, PIDs, data dir.
- `health.json`, `app-head.html`: readiness proof.
- `doctor.json`, `doctor-plugin-list.json`: doctor verdict.
- `status-claude.json`, `status-codex.json`, `start-codex.json`,
  `poll-codex.json`, `cancel-codex.json`, `login-codex-apikey-invalid.json`,
  `status-codex-apikey.json`, `logout-codex.json`, `start-claude.json`,
  `complete-claude-invalid.json`, `complete-claude-malformed.json`,
  `cancel-claude.json`, `status-after-claude.json`,
  `status-after-codex.json`, `drive-auth.json`: drive assertions.
  Invalid-token request bodies are stored redacted; secrets are never
  printed or persisted.
- `server.log`, `app.log`: copied in by cleanup before scratch removal.
- `cleanup.json`: teardown report.

Proof standard: exercise the real user path (the plugin RPCs the settings
sections call), capture the action and the resulting state, and verify side
effects (cancel actually cancels; status re-read after mutation). The
invalid-token completes and the Codex API-key round trip prove the write
path end to end against the credential files (`~/.claude/`,
`~/.codex/auth.json`) in scratch homes.

## Cleanup

```sh
node repile/verify/control-repile.mjs cleanup --state <run.json>
```

Cleanup copies both service logs into the proof dir, stops only the PIDs this
run launched (SIGTERM, then SIGKILL after a grace period; process-group first,
single PID as fallback), removes the scratch dir, and writes `cleanup.json`.
Proof artifacts survive: after cleanup, confirm the proof dir still exists and
holds the files listed above. Never kill by process name. Never delete the
proof dir.

## Helpers

`control-repile.mjs` is the only helper and it is executable
(`chmod +x repile/verify/control-repile.mjs`). Subcommands: `launch`,
`doctor`, `drive-auth`, `cleanup`, `vps-doctor`, `vps-drive-auth`. Options: `--state <path>`
(run.json path; falls back to `REPILE_VERIFY_STATE`), `--root <path>`
(verify-root override; proof goes to `<root>/proof/<run-id>/`). Every command
prints the evidence paths it wrote. A helper the reader has to reverse-engineer
is not a helper: invocations above are literal.
