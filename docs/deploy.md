# Deploy

Publishing is optional. Without it, `preview` renders every issue and serves it on your machine. To share issues, `publish` uploads them to an **issues bucket**: any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2). Only what changed is uploaded.

`init` writes the data repo's workflows. `.github/workflows/daily.yml` makes the issue at `CUTOFF` in `DIGEST_TZ` on the project's issue days: `make` (collect and the agents), render, `check`, publish, and a commit of the issue folder to the data repo. GitHub's cron is UTC, so it fires at both possible UTC hours and runs only the one in the cutoff's local hour. Run it by hand with a date, `from` and `dry_run` (on by default: make and check, no publish or commit). `.github/workflows/publish.yml` publishes the whole archive when the engine is upgraded, the project or its map changes, or by hand. Both need the `publish` environment:

| Name | Kind | What |
|---|---|---|
| `S3_ENDPOINT` | variable | the store's full URL, e.g. `https://<account>.r2.cloudflarestorage.com` or `https://s3.eu-central-1.amazonaws.com` |
| `S3_BUCKET` | variable | `daily-token` |
| `S3_REGION` | variable | only where the store needs one (AWS) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | secret | a write key for the bucket. The older `R2_*` names are still read |
| `SITE_URL` | variable | the site's address, for the Slack post |
| `SLACK_WEBHOOK_URL` | secret | optional: incoming webhook for the allowed channel |
| `DIGEST_TZ`, `CUTOFF` | variable | the window's time zone and cutoff, e.g. `Europe/Berlin`, `18:00` (daily) |
| `SOURCE_TOKEN` | secret | read-only on the project's repos: contents, pull requests, issues (daily) |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | secret | for the agents; the CLI is pinned to Claude Code 2.1.289 (daily) |

## The site

The site reads the bucket and nothing else. `/` lists the projects (or opens the only one), `/<project>/` is its latest issue, `/<project>/<date>/` an issue, `/<project>/archive` all of them, `/static/*` the pinned assets every project shares. The routes live in `src/site.ts`, and two hosts serve them:

- **`daily-token serve`** (`--port 8787`, `--host 127.0.0.1`): wherever Bun runs, on your laptop, a VM or a container, with the bucket's `S3_*` settings. It checks no one: keep it on localhost, or put it behind your own sign-in (a reverse proxy, Tailscale, oauth2-proxy).
- **The Cloudflare Worker** (`deploy/cloudflare`), optional: the bucket bound as R2 (`bucket_name` in `wrangler.toml`), behind Cloudflare Access.

## Access

On Cloudflare, the site sits behind Access. Access decides who may read; the Worker refuses any request Access didn't sign, so a policy or route mistake fails closed. Set it up once, with the domain's zone in the same Cloudflare account:

1. Zero Trust → Settings → Authentication: add **One-time PIN**. Readers sign in with a code mailed to them.
2. Zero Trust → Access → Applications → **Self-hosted**, domain as in `WORKER_DOMAIN`, session about a week. Policy: **Allow**, include **Emails**, one per reader. Nothing else.
3. Copy the team domain (`https://<team>.cloudflareaccess.com`) and the app's **Application Audience (AUD) tag** into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `.env`, with the domain in `WORKER_DOMAIN`, then `mise run worker:deploy`. None of them is in the repo.

Add or remove a reader in the policy; no deploy needed. With either variable empty the Worker answers 503. `wrangler dev` on localhost skips the check.
