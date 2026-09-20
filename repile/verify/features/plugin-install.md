# Plugin install

Plugin install puts the `repile-provider-auth` plugin onto an instance from a
local path source, so Settings → AI providers and `bb provider-auth` exist on
that instance. The plugin builds from source at install time.

## Sub-features

- `install-path` installs from `repile/plugins/repile-provider-auth`.
- `install-visible` lists the plugin with a running status afterwards.

## How to get to it (user POV)

- Run `bb plugin install --yes path:<repo>/repile/plugins/repile-provider-auth`
  against the target instance, then open Settings → AI providers.
- Run `bb plugin list` to confirm it is installed.

## Driving it with control-repile

Preconditions:

- A stack was started by `control-repile.mjs launch` in this run.
- `REPILE_VERIFY_STATE` points at its `run.json`.
- The plugin's dependencies are installed: `repile/plugins/` is outside the
  pnpm workspace, so run `npm install --no-audit --no-fund` inside
  `repile/plugins/repile-provider-auth` first (the repo's own
  `repile/provisioning/update.sh` does this before every install). Without it
  the install fails with HTTP 422 `Could not resolve "zod"` and nothing is
  installed; that failure is environmental, not a harness bug.

- **Install.** Install from the path source. Run
  `control-repile.mjs install-plugin`. `install-plugin.txt` shows the exact
  command, exit code 0, and the installed plugin summary.
- **Confirm visibility.** List plugins on the instance. Run
  `control-repile.mjs doctor`. `doctor.json` records `plugin-installed` pass
  and `doctor-plugin-list.json` holds the listing output.
- **Proof.** The install transcript plus the doctor listing prove the plugin
  built from this checkout's source and runs on this run's server.

## Gotchas

- Install goes through the server API, so the isolated server must be up;
  installing with `BB_SERVER_URL` pointed anywhere else targets that instance.
- Path installs record the absolute source path; moving the checkout
  invalidates the recorded source.
- The build needs the plugin's dependencies installed. A dependency failure
  fails the install, not the harness; read `install-plugin.txt` stderr.
