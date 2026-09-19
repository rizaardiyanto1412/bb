# Provider login (`repile-provider-auth`)

Sign the Claude and Codex CLIs in from bb Settings with a browser-based token
login flow. Lives in the standalone `plugins/` tree (split to its own repo
later); it is not part of `bb/`.

## Flow

Claude (`claude setup-token`):

1. Settings → AI providers → Claude → Login calls `POST /auth/start`.
2. The backend spawns `claude setup-token` on the bb server host, captures the
   authorize URL from its stdout, and keeps the process alive in memory while
   the session is `awaiting-user`.
3. Open the URL, authorize, paste the setup token, Submit calls
   `POST /auth/complete`. The token is written to the process stdin, the
   backend awaits exit, then verifies by reading the credential file
   (`~/.claude/.credentials.json`, macOS keychain first — the same reads as
   `plugins/provider-claude-code/src/bridge/provider-maintenance.ts`).

Codex (API key):

1. Codex → Login calls `POST /auth/start`, which probes the `codex` CLI and
   returns an `awaiting-user` session with no URL.
2. Paste an API key, Submit calls `POST /auth/complete`. The backend spawns
   `codex login --with-api-key`, feeds the key over stdin, awaits exit, then
   verifies by reading `$CODEX_HOME/auth.json` (default `~/.codex/auth.json` —
   the same reads as
   `plugins/provider-codex/src/ai/codex-auth.ts`).

`GET /auth/status?provider=claude|codex` returns
`{ provider, loggedIn, planLabel, expiresAt, accountEmail }`.
`DELETE /auth/login?provider=…` cancels a pending flow and kills its process.
Every terminal transition publishes the `auth-changed` realtime event so open
Settings pages refresh. A `provider-auth` background service prunes stale
sessions and kills orphaned login processes. `bb provider-auth status`
reports the same state from the terminal.

## No-secret-persistence rule

Tokens, API keys, and pasted secrets exist only in process memory for the
duration of one `POST /auth/complete` call:

- never written to plugin SQLite, KV, settings, or the data dir;
- never included in realtime payloads (only `{ provider, state }`);
- never logged (error details are redacted before they are stored);
- passed to the CLIs over process stdin only — the CLIs own storage
  (`~/.claude/.credentials.json`, `~/.codex/auth.json`).

Login sessions are in-memory records
`{ provider, state: awaiting-user | completed | failed, url?, error? }` plus
the live child handle. Terminal records are pruned after 5 minutes,
pending flows time out after 10 minutes.

## Install on an instance (path source for dogfood)

The plugin builds from source at install time (bb bundles `server.ts` and
`app.tsx` with its own toolchain). From the machine running your dogfood bb:

```sh
bb plugin install path:/Users/rizaardiyanto/Documents/repile/plugins/repile-provider-auth
```

then open Settings → AI providers. Useful follow-ups:

```sh
bb plugin logs repile-provider-auth
bb provider-auth status
bb provider-auth status --provider codex --json
```

Requirements on the bb server host: the `claude` and/or `codex` CLI on PATH.
Login happens on the server host only — enrolled remote hosts are untouched.

## Develop

```sh
cd plugins/repile-provider-auth
npm install
npx tsc --noEmit
npx vitest run --config vitest.config.ts
```

`prepare:bundled` is `bb-plugin-build prepare-bundled`; against a bb checkout
it can be driven without installing anything into `bb/`:

```sh
cd plugins/repile-provider-auth
<bb-checkout>/node_modules/.bin/tsx <bb-checkout>/packages/plugin-build/src/cli.ts prepare-bundled
```
