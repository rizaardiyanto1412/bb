# App shell

App shell is the served Repile web UI: the Vite dev app answers on its own
loopback port, proxies API traffic to the isolated server, and serves the
document with the Repile title.

## Sub-features

- `shell-serves` returns HTTP 200 with `<title>Repile</title>` at `/`.
- `shell-proxies-api` forwards `/api` traffic to the isolated server.

## How to get to it (user POV)

- Open the App URL printed by launch in a browser.
- `curl http://127.0.0.1:<app-port>/` from a terminal.

## Driving it with control-repile

Preconditions:

- A stack was started by `control-repile.mjs launch` in this run.
- `REPILE_VERIFY_STATE` points at its `run.json`.

- **Serve check.** Fetch the App URL. Run `control-repile.mjs doctor`.
  `doctor.json` records `app-title` pass and `app-head.html` holds the first
  bytes of the served document showing `<title>Repile</title>`.
- **Proof.** Re-read `app-head.html` in the proof dir. The artifact shows the
  Repile title served from this run's App URL, not the developer's instance.

## Gotchas

- The developer's own dev instance serves the same title on different ports.
  Assert the URL from this run's `run.json`, never a remembered port.
- First boot compiles the app; the app check allows up to 180s. A fast
  failure usually means the port was taken between probe and bind.
- `shell-proxies-api` is covered indirectly: every `drive-auth` status call
  the Settings page makes goes through the same route base.
