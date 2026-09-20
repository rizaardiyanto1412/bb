# Repile

Product repo for Repile. Paid SaaS that automates support-ticket triage for
WordPress plugin companies and agencies. Living product plan lives in
`repile/docs/repile-plan.md`.

## Layout

- `repile/plugins/` — reserved for custom bb plugins (currently empty; provider
  subscription login lives inside the bundled `plugins/provider-claude-code`
  and `plugins/provider-codex` in the bb fork).
- `repile/provisioning/` — VPS setup and update scripts plus service templates.
- `.github/workflows/deploy-repile.yml` — push to `main` deploys to the dogfood VPS.

## Deploy flow

Local dev happens in the bb fork (branch `repile`) and in `repile/plugins/` here.
Push this repo to `main` and the Action SSHs to the VPS and runs
`repile/provisioning/update.sh`. The Action needs two repository secrets:

- `VPS_HOST` — VPS address or hostname.
- `VPS_SSH_KEY` — private SSH key for `root@VPS_HOST`.
