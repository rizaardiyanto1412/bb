# Repile verification map

This directory is the maintained source for verifying the user-facing behavior
of Repile. Read the index before driving the app, then use the matching feature
file as the recipe.

## Baseline preconditions

- Launch a stack with `control-repile.mjs launch` and export its state file as
  `REPILE_VERIFY_STATE`. Never drive an instance this run did not start.
- The developer's own dev instance (whatever ports `pnpm dev` printed) is
  off-limits; the harness probes its own free ports.
- Run `control-repile.mjs doctor` and require health, app title, and plugin
  presence before driving.
- `claude` and `codex` CLIs are expected on `PATH`; the harness inherits
  `PATH` and redirects their homes to scratch.
- Real OAuth completion needs a human and is never attempted by automation.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say
  otherwise.
- Loopback calls use no `Origin` header and `content-type: application/json`
  on POST and DELETE (`auth: "local"` semantics).
- Run server and app actions through `control-repile.mjs drive-auth`.
- Run terminal actions through the `bb` CLI with `BB_SERVER_URL` pointed at
  the isolated server (the harness does this for you).
- Never print or persist secrets. Invalid probe tokens are stored redacted.
- Restore nothing; scratch state is disposable. Do not remove proof artifacts
  during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- HTTP proof includes status code and response body per call.
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof includes a re-read (status after start/complete/cancel).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet
  precondition.
- Do not report a skipped entry point as verified through a different path.
- The human OAuth click is reported as human-gated, never as verified.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-repile` starts with `Preconditions:` and uses
   labeled bullets that pair each user action with an exact command and
   observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable
handles, required state, commands, and observable proof.

## Features

- [App shell](./app-shell.md) covers the served web UI and its identity.
- [Provider auth status](./provider-auth-status.md) covers reading Claude and
  Codex login state from Settings and the CLI.
- [Provider auth flow](./provider-auth-flow.md) covers starting, failing, and
  cancelling logins, plus the human-gated OAuth step.
- [Plugin install](./plugin-install.md) covers installing the plugin from a
  path source onto an instance.
