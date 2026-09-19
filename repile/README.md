# Repile

Product repo for Repile. Paid SaaS that automates support-ticket triage for
WordPress plugin companies and agencies. Living product plan lives in
`repile/docs/repile-plan.md`.

## Layout

- `repile/plugins/` — custom bb plugins. Each folder is one plugin, installed on
  instances via `path:` source for dogfood and `git:` source later.
- `repile/provisioning/` — VPS setup and update scripts plus service templates.
- `.github/workflows/deploy-repile.yml` — push to `main` deploys to the dogfood VPS.

## Deploy flow

Local dev happens in the bb fork (branch `repile`) and in `repile/plugins/` here.
Push this repo to `main` and the Action SSHs to the VPS and runs
`repile/provisioning/update.sh`. The Action needs two repository secrets:

- `VPS_HOST` — VPS address or hostname.
- `VPS_SSH_KEY` — private SSH key for `root@VPS_HOST`.
