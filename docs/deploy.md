# Deploy

Publishing is optional. Without it, `preview` renders every issue and serves it on your machine. To share issues, `publish` uploads them to an **issues bucket**: any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2). Only what changed is uploaded.

`init` writes the data repo's workflows. `.github/workflows/daily.yml` makes the issue at `CUTOFF` in `DIGEST_TZ` on the project's issue days: `make` (collect and the agents), render, `check`, publish, and a commit of the issue folder to the data repo. GitHub's cron is UTC, so it fires at both possible UTC hours and runs only the one in the cutoff's local hour. Run it by hand with a date, `from` and `dry_run` (on by default: make and check, no publish or commit). `.github/workflows/publish.yml` publishes the whole archive when the engine is upgraded, the project or its map changes, or by hand. Both need the `publish` environment:

| Name | Kind | What |
|---|---|---|
| `S3_ENDPOINT` | variable | the store's full URL, e.g. `https://<account>.r2.cloudflarestorage.com` or `https://s3.eu-central-1.amazonaws.com` |
| `S3_BUCKET` | variable | `daily-token` |
| `S3_REGION` | variable | only where the store needs one (AWS) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | secret | a write key for the bucket. The older `R2_*` names are still read |
| `SITE_URL` | variable | the site's address, for the Slack post and the link previews |
| `SLACK_WEBHOOK_URL` | secret | optional: incoming webhook for the allowed channel |
| `DIGEST_TZ`, `CUTOFF` | variable | the window's time zone and cutoff, e.g. `Europe/Berlin`, `18:00` (daily) |
| `SOURCE_TOKEN` | secret | read-only on the project's repos: contents, pull requests, issues (daily) |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | secret | for the agents; the CLI is pinned to Claude Code 2.1.289 (daily) |

## The site

The site reads the bucket and nothing else. `/` lists the projects (or opens the only one), `/<project>/` is its latest issue, `/<project>/<date>/` an issue, `/<project>/archive` all of them, `/static/*` the pinned assets every project shares. The routes live in `src/site.ts`, and two hosts serve them:

- **`daily-token serve`** (`--port 8787`, `--host 127.0.0.1`): wherever Bun runs, on your laptop, a VM or a container, with the bucket's `S3_*` settings. Without the sign-in settings below it checks no one, so it serves only on this machine.
- **The Cloudflare Worker** (`deploy/cloudflare`), optional: the bucket bound as R2 (`bucket_name` in `wrangler.toml`).

## Sign-in

Readers sign in with GitHub. Whoever can see one of the project's GitHub repos may read it; GitHub keeps the list, so there's none to keep here. project.json's `access` names other repos and a role (`{ "github": ["owner/repo"], "role": "push" }`), or makes a project `"public"`.

Without a sign-in, an issue's address shows only its preview: the share cover, which shows nothing of the work unless `cover.headline` is on, and a button to sign in. So a link to an issue unfurls in Slack or a chat app, and sharing from a phone works. Everything else of a project stays shut.

Set it up once:

1. `daily-token github-app` (`--org NAME` for an organization's): it opens GitHub with the app filled in, from `SITE_URL`. Press **Create**. Its Client ID and secret go into `.env` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, with a new `SESSION_SECRET`. The app reads only repository Metadata, the least it can be installed on repos with, and has no webhook.
2. **Install** it on the project's repos, on the page GitHub opens next. A reader's sign-in reaches only the repos it's installed on.
3. `mise run worker:secrets`, then publish (it writes who may read into the bucket), then `mise run worker:deploy`. For `serve`, the same three in its env.

A session lasts 12 hours, then the reader signs in again, which takes no click while they're signed in to GitHub. So someone who loses access to the repos loses the digest within 12 hours. Rotating `SESSION_SECRET` signs everyone out. Without the three settings no one signs in, and only public projects and previews show; `wrangler dev` on localhost without them is open.
