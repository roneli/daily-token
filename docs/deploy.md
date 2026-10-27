# Deploy

Publishing is optional. Without it, `preview` renders every issue and serves it on your machine. To share issues, `publish` uploads them to an **issues bucket**: any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2). Only what changed is uploaded.

`init` writes the data repo's workflows. `.github/workflows/daily.yml` makes the issue at `CUTOFF` in `DIGEST_TZ` on the project's issue days: `make` (collect and the agents), render, `check`, publish, and a commit of the issue folder to the data repo. GitHub's cron is UTC, so it fires at both possible UTC hours and runs only the one in the cutoff's local hour. Run it by hand with a date, `from` and `dry_run` (on by default: make and check, no publish or commit). `.github/workflows/publish.yml` publishes the whole archive when the engine is upgraded, the project or its map changes, or by hand. Both read the data repo's own Actions secrets and variables (Settings → Secrets and variables → Actions), with no environment. Run in a terminal, `init` offers to make the data repo (private, with `gh repo create`) and to set them with `gh`, a secret on stdin, never in a command line; `init --dry-run` prints those commands, values hidden, and runs none:

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

### Where each key comes from

- **`SOURCE_TOKEN`**: a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new). Resource owner: the repos' owner. Repository access: only the project's repos. Repository permissions: Contents, Pull requests and Issues, each Read-only. Locally the same token goes in `.env` as `GH_TOKEN`.
- **`CLAUDE_CODE_OAUTH_TOKEN`**: run `claude setup-token`, which signs in with your Claude subscription and prints a token. Or **`ANTHROPIC_API_KEY`** instead: a key from the [Anthropic Console](https://console.anthropic.com/settings/keys), billed per use. Locally the agents use your Claude login.
- **`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`**: on Cloudflare, the dashboard → R2 → Manage API tokens → Create API token, with **Object Read & Write** applied to the bucket ([R2 tokens](https://developers.cloudflare.com/r2/api/tokens/)). It shows the key, its secret and the endpoint, `https://<account>.r2.cloudflarestorage.com`. Another store: a key that may read and write the bucket. They go in `.env` too, for `publish` from your machine.
- **`SLACK_WEBHOOK_URL`**: optional. [api.slack.com/apps](https://api.slack.com/apps) → your app → Incoming Webhooks → Add New Webhook, for the channel.

## The site

The site reads the bucket and nothing else. `/` lists the projects (or opens the only one), `/<project>/` is its latest issue, `/<project>/<date>/` an issue, `/<project>/archive` all of them, `/static/*` the pinned assets every project shares. The routes live in `src/site.ts`, and two hosts serve them:

- **`daily-token serve`** (`--port 8787`, `--host 127.0.0.1`): wherever Bun runs, on your laptop, a VM or a container, with the bucket's `S3_*` settings. Without the sign-in settings below it checks no one, so it serves only on this machine.
- **The Cloudflare Worker** (`deploy/cloudflare`), optional. `daily-token deploy` puts it up from `.env`: it signs in to Cloudflare if it must (`wrangler login`), makes the bucket `S3_BUCKET` in R2 if it isn't there, deploys the Worker on the host of `SITE_URL` (or `WORKER_DOMAIN`, in a zone of the same account) and stores the sign-in's secrets. Run it again after any change. Publishing to R2 also needs an S3 key: R2 → Manage API tokens → Object Read & Write on the bucket, into `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, with `S3_ENDPOINT` `https://<account>.r2.cloudflarestorage.com`.

### Many projects

Several data roots can publish to one bucket, and one site serves them all. With `SITE_DOMAIN` set (e.g. `example.com`), each project also has its own host, `<id>.example.com`, which serves that project alone, so its sign-in is its own. Any other host lists every project the visitor may read. For each project:

1. Its data root publishes to the same bucket, with `SITE_URL=https://<id>.example.com`.
2. Add `<id>.example.com` to `WORKER_DOMAIN` (comma-separated) and `daily-token deploy`. A deploy sets the Worker's whole list of domains, so `WORKER_DOMAIN` names every project's host, wherever you deploy from.
3. Add `https://<id>.example.com/auth/callback` to the GitHub App's callback URLs, unless the project is public. An app takes 10.

`HOME_PROJECT=<id>` makes the bare `example.com` that project's own host too; its callback URL is `https://example.com/auth/callback`. `daily-token home DIR` then puts a front page of your own at `/` (a folder with `index.html` and its files), for whoever may read that project; the project's issues stay at `/<id>/`.

## Sign-in

Readers sign in with GitHub. Whoever can see every one of the project's GitHub repos may read it, since a digest tells of all of them; GitHub keeps the list, so there's none to keep here. project.json's `access` names other repos and a role (`{ "github": ["owner/repo"], "role": "push" }`), or makes a project `"public"`.

Without a sign-in, an issue's address shows only its preview: the share cover, which shows nothing of the work unless `cover.headline` is on, and a button to sign in. So a link to an issue unfurls in Slack or a chat app, and sharing from a phone works. Everything else of a project stays shut.

Set it up once:

1. `daily-token github-app` (`--org NAME` for an organization's): it opens GitHub with the app filled in, from `SITE_URL`. Press **Create**. Its Client ID and secret go into `.env` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, with a new `SESSION_SECRET`. The app reads only repository Metadata, the least it can be installed on repos with, and has no webhook.
2. **Install** it on the project's repos, on the page GitHub opens next. A reader's sign-in reaches only the repos it's installed on.
3. `daily-token deploy`, then publish: it writes who may read into the bucket. For `serve`, the same three in its env.

A session lasts 12 hours, then the reader signs in again, which takes no click while they're signed in to GitHub. So someone who loses access to the repos loses the digest within 12 hours. Rotating `SESSION_SECRET` signs everyone out. Without the three settings no one signs in, and only public projects and previews show; `wrangler dev` on localhost without them is open.
