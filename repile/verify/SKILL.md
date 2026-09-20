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
3. `bb plugin list --json` against the isolated server shows
   `repile-provider-auth` (proves the plugin is installed on this instance).

Doctor fails if any check fails. A failed doctor means stop and investigate;
do not proceed to drive.

## Drive

Install the plugin under test, then exercise provider-auth without human OAuth:

```sh
node repile/verify/control-repile.mjs install-plugin --state <run.json>
node repile/verify/control-repile.mjs drive-auth --state <run.json>
```

Install runs `bb plugin install --yes path:<repo>/repile/plugins/repile-provider-auth`
with `BB_SERVER_URL` pointed at the isolated server, and saves the transcript
to `install-plugin.txt`. `repile/plugins/` is outside the pnpm workspace, so
the plugin dir needs its own dependencies first
(`npm install --no-audit --no-fund` inside it, as
`repile/provisioning/update.sh` does); without them the install fails with
HTTP 422 `Could not resolve "zod"`.

Drive-auth performs the loopback calls a browser would make, using the same
`auth: "local"` semantics the SDK enforces (verified in
`packages/plugin-sdk/src/backend-contract.ts` and
`apps/server/src/browser-request-guard.ts`): loopback `Host`, no `Origin`
header, and `content-type: application/json` on every POST and DELETE. The
sequence, all against
`/api/v1/plugins/repile-provider-auth/http`:

- `GET /auth/status?provider=claude` and `?provider=codex`, asserting HTTP 200
  and the `{ provider, loggedIn }` shape.
- `POST /auth/start` for `codex`, asserting `awaiting-user` with a null URL or
  `completed` when already signed in.
- `POST /auth/start` for `claude`, asserting `awaiting-user` with an `https://`
  authorize URL or `completed` when already signed in.
- `POST /auth/complete` with an invalid token for `codex` (always),
  asserting HTTP 200 with `state: "completed"`: the Codex CLI performs no
  key validation at login, so the plugin mirrors it and a bad key only
  fails at first real use. Never report this as rejection proof.
- `POST /auth/complete` with an invalid token for `claude` (only when a
  flow is awaiting-user), asserting HTTP 200 with `state: "failed"` and a
  non-empty error: a graceful failure, not a crash. Real OAuth completion
  needs a human and is explicitly out of scope.
- `DELETE /auth/login?provider=...` for both providers, asserting
  `{ cancelled: true }`, then `GET /auth/status` again for both.
- `bb provider-auth status` (text) asserting exit 0, both provider names
  present, and the invalid token absent from all output (no-secret rule).
- `bb provider-auth status --provider codex --json` asserting exit 0 and
  parseable JSON with `provider: "codex"`.

The feature map in `features/` names every entry point; `drive-auth` covers
the machine-verifiable ones. The one human-gated step (clicking the authorize
URL and pasting a real token) is marked in
`features/provider-auth-flow.md` and is never attempted.

## VPS target

The same flows run against the production VPS without touching local state:

```sh
node repile/verify/control-repile.mjs vps-doctor
node repile/verify/control-repile.mjs vps-drive-auth
```

`vps-doctor` asserts systemd units active, loopback 200 with the Repile
title, the plugin CLI answering, and public HTTPS returning 401.
`vps-drive-auth` runs start plus invalid-complete plus cancel for Claude
over SSH loopback curl and stores redacted evidence in its own proof dir.
It never submits real secrets and never restarts services. Prefer the
local target for iteration; use the VPS target to prove what is deployed.

## Evidence

Every command writes into the run proof dir `repile/verify/proof/<run-id>/`:

- `run.json`, `urls.txt`: launched URLs, ports, PIDs, data dir.
- `health.json`, `app-head.html`: readiness proof.
- `doctor.json`, `doctor-plugin-list.json`: doctor verdict.
- `install-plugin.txt`: install transcript.
- `status-claude.json`, `status-codex.json`, `start-codex.json`,
  `start-claude.json`, `complete-codex-invalid.json`,
  `complete-claude-invalid.json`, `cancel-claude.json`, `cancel-codex.json`,
  `status-after-claude.json`, `status-after-codex.json`,
  `cli-provider-auth-status.txt`, `cli-provider-auth-codex.txt`,
  `drive-auth.json`: drive assertions. Invalid-token request bodies are stored
  redacted; secrets are never printed or persisted.
- `server.log`, `app.log`: copied in by cleanup before scratch removal.
- `cleanup.json`: teardown report.

Proof standard: exercise the real user path (HTTP routes the Settings UI
calls, CLI commands a user runs), capture the action and the resulting state,
and verify side effects (cancel actually cancels; status re-read after
mutation). The invalid-token completes prove the failure path end to end
against the real `claude`/`codex` CLIs in scratch homes.

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
`doctor`, `install-plugin`, `drive-auth`, `cleanup`. Options: `--state <path>`
(run.json path; falls back to `REPILE_VERIFY_STATE`), `--root <path>`
(verify-root override; proof goes to `<root>/proof/<run-id>/`). Every command
prints the evidence paths it wrote. A helper the reader has to reverse-engineer
is not a helper: invocations above are literal.
