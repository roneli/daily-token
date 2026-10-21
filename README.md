# The Daily Token

Agents open more PRs than anyone can follow. The Daily Token turns a day of merges into reels, one thread of short scenes per story, and a plain-words digest. It reads them from GitHub, checks every claim against the data, and posts the issue to a site and a Slack channel.

## Getting started

```
bun create daily-token my-digest     # asks where the work comes from, when the day ends, where issues go
cd my-digest
bunx daily-token doctor              # token, repos, claude CLI, publishing
bunx daily-token project cartographer && bunx daily-token project cartographer --accept
bunx daily-token project brief && bunx daily-token project brief --accept
bunx daily-token run --date 2026-10-18
bunx daily-token preview
```

The digest is its own repo, the **data root**, with the engine as a pinned dependency and the workflows that make an issue a day. `bunx daily-token init` in an existing data root brings it up to date: it converts an older format and adds the files it lacks. Upgrading is bumping `daily-token` in its `package.json`.

## An issue

A data root is one **project**: one digest across one or more sources. Commands find it in the current folder, or in `DATA_DIR`, or `--root`. Every issue is a folder of JSON in it. Every publish renders every issue's HTML again from that JSON, so a template or player fix reaches the whole archive (see [Formats](#formats)). Without `DATA_DIR`, every command uses the made-up fixture in `fixtures/sample` (the project Rocket: `acme/rocket` and `acme/ground`).

```
<DATA_DIR>/project.json         { id, name, sources, days?, pipeline? }: where the work comes from, the issue days, the pipeline's tuning
<DATA_DIR>/system.json          the project's parts, groups and edges (the Blueprint map)
<DATA_DIR>/issues/2026-10-18/
  data.json      collect: each source's slice under sources.<name>. The truth.
  stories.json   the digest: sections and one card per PR
  reels.json     the reels: a thread per story, each 1–5 shorts of a template and its fields
  motion.json    optional: the Cutaway's storyboard, a tour of the system map stop by stop, and its narration
  review.json    each agent stage's rounds: the reviewers' scores, asks, and why the loop stopped
  trace/         every round's draft, gate findings and review, per stage
  meta.json      every agent run with its model, attempts, time and cost; the final check
```

The page has three tabs, a fourth when the edition has a motion, and an editions rail listing every past issue, weekly (Thursday) editions first:

- **Reels**: a thread per story, like stories on Instagram: a tray of circles, one per story, and 1–5 shorts in each, one idea each, 6–12 s. It plays on into the next story. On a phone, tap the right of a short for the next, the left for the one before, and hold to pause; swipe left or right for another story, and up to read its cards. On a wide screen the stories sit as a stack of cards, the neighbours dimmed behind: click the card for the next short (its left third for the one before) and a card behind it, or the space beside, for another story. Keys: ← → for shorts, shift ← → for stories, ↑ to read, space to pause. The bar at a card's foot opens the story's cards. A circle turns grey once its story is watched, on that device.
- **Digest**: one card per PR with a type, the parts it touched, who made it, a plain sentence, and "Under the hood".
- **Blueprint**: the system map, with each part that changed lit and clickable.
- **Cutaway**: a 40–90 s narrated tour of the whole system along one flow, with its narration to read under it (each line plays the video from there) and the PRs it marks new today. Its name is `MOTION_TAB` in `src/motion.ts`, the only place it is written.

### The Cutaway

The tab is named after a newspaper's cutaway diagram, the drawing that shows the inside of a machine. An edition gets a motion only when the run asks for one (see [the pipeline](#the-pipeline)). The reels tell the day's news; the Cutaway explains how something in the system works, as the answer to a question with a stake ("How does new firmware reach every thermostat without turning off anyone's heating?"). Each motion follows **one flow across the system map** (a request's journey, how a new version reaches every machine, what happens when a machine joins) or opens one area and shows where it sits, on one living map: it opens on the whole of `system.json`, the camera flies from part to part, a request travels each edge with a glowing trail, the part it reaches lights and, where the how happens, opens into a small live flow: its steps light in order as they are spoken, a token running from one to the next, and a step's failure branch lights in red, a "New today" badge pulses on the parts today's PRs touched, and it ends pulling back over the whole path. A voice reads the narration, and captions show it.

A stop opens its part with one of the engine's **moves**, drawn in the map's style inside the part, one beat per spoken sentence (`templates/motion/moves.ts`): `steps` (a sequence down a spine, a failure branching off in red), `fanout` (one sender to many receivers, in waves), `cycle` (a loop the token keeps running), `layers` (nested rings, the camera going one ring in a beat), `compare` (the same moment two ways, row by row) and `gate` (a request meets a check and is refused, with its reason, or let through). When none fits, a stop may compose a `free` beat from the engine's primitives (nodes, links, copies, tokens, texts, and pulse, fade, draw, zoom and orbit), placed on a 4×4 grid of slots, never at coordinates of its own: `check` holds it to its own parts, one thing a slot and at most 40 elements, and `meta.json` logs each free beat and why, so a pattern that recurs can become a move. The render gate refuses a card whose words would be smaller than 9 px on a phone 390 px wide, and any text on other text.

The narration follows the writing rules of ASD-STE100, Simplified Technical English (not its licensed dictionary): one idea per sentence, at most 20 words, the actor first in the active voice, present tense, and the brief's one name for each part. `check` refuses a sentence over 20 words and warns on a passive, a vague verb, a part called by two names, one name used for two parts, and narration that reads like a list: three sentences in a row starting with the same noun, or naming the same part.

The **Explainer** (`agents/explainer.md`) writes no code and chooses no coordinates: it returns a storyboard (`schemas/motion.schema.json`): a title, a dek, the flow's name, the question it answers, an opening line that asks it, 4–8 **stops** and a closing line that answers it. A stop names a part, the edge it arrived by (its label in `system.json`) or `inside` for two parts in one frame of the map, a line to say (what happens there, why, and what if it fails), at least half the stops a `move` and its beats (a label, the sentence spoken while it plays, a tone, and what the move needs: a failure, a count, a check), and optionally today's PRs that changed it. `pipeline.motion.topic` (or `--set motion.topic="..."` for one run) gives the Explainer the flow to tour.

The engine does the rest (`templates/motion/`, engine-owned like a reel's `layout.ts`):

- `tour.layout.ts` lays out at most six parts (the tour's, then their neighbours) at video size, so a phone reads every name on the whole map: with [ELK](https://eclipse.dev/elk/), with the map's groups or without, or, when a loop or a long chain would come out tall and thin, in the tour's own order on a two-column grid, works out the camera, and writes every beat as tracks of keyframes. `tour.liquid` and `tour.css` draw it, in the issue's fonts on a night palette: the fonts are fetched from Google Fonts once into `~/.cache/daily-token/fonts` and inlined, every face loaded before the first frame, so every tab films the same faces; with no network and nothing cached, the fallback faces draw the whole film; `tour.js` only plays the tracks: `seek(ms)` puts every element where it is at that moment.
- **The voice** is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) through `kokoro-js` 1.2.1, the 82M model quantized (q8), on the CPU. Its ONNX runtime doesn't load under Bun, so `src/speak.mjs` runs under **Node 20 or later**. The model (about 90 MB) is downloaded once into `~/.cache/daily-token/models`, and every spoken line is kept in `~/.cache/daily-token/speech` by its words and voice (`DAILY_TOKEN_CACHE` moves both). Every sentence is its own clip, trimmed of the silence around it, so a step lights exactly as its sentence starts; a beat lasts as long as its sentences take to say, a breath between them, plus the camera's move. Review rounds aren't spoken: the Viewer sees pictures and reads the words, so a round is timed by an estimate (about 2.8 words a second at speed 1 and a breath at each comma, fitted on Kokoro's own trimmed clips) and checked for length by it. Only the storyboard the loop keeps is spoken, once, after the loop; if the voice runs long or short of 40–90 s, the moves and pauses around the words shrink or stretch to fit, and the stage fails, saying so, only when even that can't. `pipeline.motion.voice` picks the voice (`af_heart`, the voice Kokoro's own docs lead with and rate highest) and `pipeline.motion.speed` its pace (1.08, a touch livelier than Kokoro's default); `pipeline.motion.voiceover: false` makes a silent video timed by its words.
- **The film**: Playwright opens the page in headless Chrome (the one `look` uses), four tabs at once seek frame by frame, each frame is a JPEG screenshot over the DevTools protocol, and **ffmpeg** reads them in order from a FIFO, with the voice as raw PCM, and encodes them: H.264 (libx264 at CRF 28, preset slow, tuned for animation, with adaptive quantization for the dark gradients; OpenH264 where the build has no libx264), yuv420p, AAC at 80 kb/s, `+faststart`, 30 fps, 1080×1350: about 2.8 MB a minute. A minute takes about 27 s on a laptop. `FFMPEG` points at another ffmpeg. The poster is the closing pull-back. It is all made in a scratch folder and moved beside the page only once whole, so a failed render leaves nothing to publish, and its error says what failed.

`render` writes the MP4, its poster and its timing (`motion.<hash>.json`: when each line is spoken, for the tab) beside the page, named by a hash of the storyboard, the map as the tour draws it, the look, the voice, the engine's motion code, the layout library and the fonts, so an unchanged motion is never rendered twice and a new look renders again; files of an older hash are dropped, and all of them when the edition no longer has a motion.

What it needs besides Bun: **ffmpeg** on the PATH (ffmpeg is LGPL, or GPL as most builds, Ubuntu's included, are configured; the engine only runs it, so its licence doesn't reach the engine's), **Node 20+** for the voice, and Chrome. The workflows install Ubuntu's ffmpeg package (the runner image has none), set up Node 24 and cache `~/.cache/daily-token`. `kokoro-js` pulls in `onnxruntime-node`, whose install script only downloads CUDA libraries (about 340 MB) for GPUs; the CPU runtime ships in the package. Bun doesn't run a dependency's install scripts unless it is in `trustedDependencies`, so leave it out; with npm, set `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` (or install with `--ignore-scripts`).

## Templates

Templates are HTML with [LiquidJS](https://liquidjs.com) placeholders. They hold no code.

```
templates/
  issue.liquid              page shell: masthead, headline, tabs, controls
  pages/reels.liquid        one card per thread: its shorts, and its story's cards
  pages/digest.liquid       sections, cards, rail
  partials/card.liquid      a digest card
  reels/<name>.liquid       a reel template: SVG with animation marks
  reels/<name>.schema.json  the fields a reel of this template must give
  reels/<name>.layout.ts    optional: positions and timing worked out from the fields
static/daily.css            tokens and styles
static/player.js            tabs, paging, and the engine that plays the marks
templates/pages/blueprint.liquid + static/blueprint.{js,css}   the Blueprint tab
templates/partials/editions.liquid   the editions rail, filled from the site's index.json
templates/pages/motion.liquid + templates/motion/   the Cutaway tab, and the page that films as its video
schemas/                    stories.json, reels.json and motion.json
```

Text fields are plain text with three marks: `` `code` ``, `**bold**` and `#123`, which links to the PR or issue. A PR or issue in a repo other than home is `name#123`, everywhere: in text, in a card's `ref`, in a reel's `refs` and `epic`. A direct commit is its short hash, `abc1234`, or `name@abc1234` in another repo. A card's `with` lists more PRs or commits it covers, so a run of small pushes can be one story.

### Scenes and animation marks

A reel can be a template or a `scene`: SVG the Director draws itself, held to an allowlist. Both animate with `data-anim` and `data-cue` marks. The rules and the marks are in [agents/scenes.md](agents/scenes.md), which the Director reads as written.

### Reel templates

| Template | Status | Shows |
|---|---|---|
| `pipeline` | built | a token through steps, stopped by problems and fixes, then before/after metrics |
| `counter-timeline` | built | counters and tags on a timeline |
| `state-machine` | built | states a thing moves through, with a live status line |
| `sequence` | built | messages between actors, a bad reply crossed out and replaced |
| `before-after` | built | one value changing into another |
| `bars` | built | stacked bars per day by epic |
| `map-highlight` | later | a part of the system map |
| `stack` | built | progress bars and a queue |
| `title` | built | a story's title and dek in large type, for a story with nothing to draw |
| `scene` | built | anything: SVG the Director draws itself |

## Commands

`daily-token <command>` (`bun src/cli.ts` in this repo; `daily-token help` lists them):

```
init      [DIR] [--yes --name --repos a/b,c/d --tz --cutoff --days --model --publish none|r2]
run       [--date D] [--from STAGE] [--to STAGE] [--rounds N] [--set stage.key=value] [--motion | --no-motion]
replay    STAGE --date D [--set stage.key=value]
project   cartographer [--days N] [--accept]
project   brief [--days N] [--accept]
collect   [--date D] [--force]
render    [--date D | --all]
check     [--date D] [--look]
publish   [--announce D] [--dry-run]
preview   render every issue and serve out/ on :5173
serve     [--port 8787] [--host 127.0.0.1]: the site, from the issues bucket
doctor    is the data root ready
migrate   [--dry-run]: bring a data root to the current format
```

The mise tasks run the same commands on this repo: `mise run issue`, `map`, `collect`, `render`, `check`, `preview`, `publish`, `serve`, `lint`, `test`, `worker:dev`, `worker:deploy`.

`check` warns when a thread runs past 45 s or an issue has more than 8 threads; with `--look` it also measures the reels in a browser. It fails when a cited PR or commit isn't in `data.json`, one landed with no card covering it, a story has no thread, two shorts share an id, a part isn't in `system.json` or has no box, a short runs over 12 s, a cue points at nothing, or a field breaks its schema.

## Collect

`collect` asks every source configured in `project.json` for its slice of the day. A source is a plugin (`src/sources/`): a config schema, its own questions for `init`, a `doctor` check, and `collect`. GitHub is the first; it works on any repos and knows nothing about one. For a date it reads every repo in `sources.github.repos` (the first is home), over GraphQL with `GH_TOKEN`, into `data.sources.github`:

- PRs merged into each repo's default branch from the previous issue day's `CUTOFF` to this day's, in `DIGEST_TZ` (DST included), each tagged with its repo. With `"days": ["sun", "mon", "tue", "wed", "thu"]` in `project.json`, Sunday's issue reaches back to Thursday, so the weekend's work isn't lost; without `days`, every day is an issue day;
- each PR's files, every page of them, mapped to parts by the globs in `system.json`. Globs match home paths as written and another repo's as `name:path/**`. A part with `"core": true` marks the PR Core;
- **direct commits**: commits on the default branch in the window that no merged PR carries, with their files (from the REST API), closing keywords and `Part of #N`;
- co-authors from `Co-authored-by` trailers;
- its epic path: the closing issue's (or a `Part of #N` issue's) sub-issue parents, root first, which may live in another repo. No chain means no epic; a reference to a PR or a missing number is skipped;
- **issues** opened or closed in the window: reason, the PR or commit that closed it, labels, epic path and sub-issue progress;
- the epics' sub-issue progress and the tags made in the window;
- on a Thursday, `week`: Friday to Thursday per day (PRs, commits, work per epic), totals, and each epic's progress over the week. Days the archive lacks are collected again from GitHub; they count, but their epic numbers are today's, so the week's progress is then unknown (`null`), never a false zero;
- **open PRs** for what's coming, up to 50 per repo: draft, review state, author, size, parts (from the first 100 files), epic path, and whether each is new or active in the window.

Files no part matches go in `unmatched`, for the Cartographer. An existing `data.json` is never overwritten without `--force`. Tag times are the tagger's, or the commit's for a lightweight tag.

## Publishing

Publishing is optional. Without it, `preview` renders every issue and serves it on your machine. To share issues, `publish` uploads them to an **issues bucket**: any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2). Only what changed is uploaded.

`.github/workflows/daily.yml` makes the issue at `CUTOFF` in `DIGEST_TZ` on the project's issue days: `make` (collect and the agents), render, `check`, publish, and a commit of the issue folder to the data repo. GitHub's cron is UTC, so it fires at both possible UTC hours and runs only the one in the cutoff's local hour. Run it by hand with a date, `from` and `dry_run` (on by default: make and check, no publish or commit). `.github/workflows/publish.yml` publishes the whole archive on every push to `master` that touches the engine, or by hand. Both need the `publish` environment:

| Name | Kind | What |
|---|---|---|
| `S3_ENDPOINT` | variable | the store's full URL, e.g. `https://<account>.r2.cloudflarestorage.com` or `https://s3.eu-central-1.amazonaws.com` |
| `S3_BUCKET` | variable | `daily-token` |
| `S3_REGION` | variable | only where the store needs one (AWS) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | secret | a write key for the bucket. The older `R2_*` names are still read |
| `SITE_URL` | variable | the site's address, for the Slack post |
| `SLACK_WEBHOOK_URL` | secret | optional: incoming webhook for the allowed channel |
| `DIGEST_TZ`, `CUTOFF` | variable | the window's time zone and cutoff, e.g. `Europe/Berlin`, `18:00` (daily) |
| `DATA_REPO` | variable | the private data repo, `owner/name` (daily) |
| `DATA_TOKEN` | secret | contents read and write on the data repo (daily) |
| `SOURCE_TOKEN` | secret | read-only on the project's repos: contents, pull requests, issues (daily) |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | secret | for the agents; the CLI is pinned to Claude Code 2.1.289 (daily) |

### The site

The site reads the bucket and nothing else. `/` lists the projects (or opens the only one), `/<project>/` is its latest issue, `/<project>/<date>/` an issue, `/<project>/archive` all of them, `/static/*` the pinned assets every project shares. The routes live in `src/site.ts`, and two hosts serve them:

- **`daily-token serve`** (`--port 8787`, `--host 127.0.0.1`): wherever Bun runs, on your laptop, a VM or a container, with the bucket's `S3_*` settings. It checks no one: keep it on localhost, or put it behind your own sign-in (a reverse proxy, Tailscale, oauth2-proxy).
- **The Cloudflare Worker** (`apps/worker`), optional: the bucket bound as R2 (`bucket_name` in `wrangler.toml`), behind Cloudflare Access.

### Access

On Cloudflare, the site sits behind Access. Access decides who may read; the Worker refuses any request Access didn't sign, so a policy or route mistake fails closed. Set it up once, with the domain's zone in the same Cloudflare account:

1. Zero Trust → Settings → Authentication: add **One-time PIN**. Readers sign in with a code mailed to them.
2. Zero Trust → Access → Applications → **Self-hosted**, domain as in `WORKER_DOMAIN`, session about a week. Policy: **Allow**, include **Emails**, one per reader. Nothing else.
3. Copy the team domain (`https://<team>.cloudflareaccess.com`) and the app's **Application Audience (AUD) tag** into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `.env`, with the domain in `WORKER_DOMAIN`, then `mise run worker:deploy`. None of them is in the repo.

Add or remove a reader in the policy; no deploy needed. With either variable empty the Worker answers 503. `wrangler dev` on localhost skips the check.

## The pipeline

```
collect ─▶ stories ─▶ reels ─▶ motion ─▶ verify
sources    Writer      Director   Explainer   check
           ⇄ Editor    ⇄ Readers  ⇄ Viewer
                                  (when asked)
```

`daily-token run --date D` runs the stages for one day (`src/pipeline.ts`). Each reads earlier stages' files from the issue folder and writes its own, so `--from STAGE` restarts there and keeps the files before it, and `--to STAGE` stops after one. A day where every source is empty makes no issue.

Scripts do what's deterministic: collect, links, quotes against PR bodies, the epic graph, `check`. Agents do what needs judgment, and each returns JSON against a schema (`schemas/`).

### The loop

Every agent stage is one loop, `refine` (`src/harness/loop.ts`):

```
author ─▶ gates ─▶ reviewers ─▶ decide ─┐
  ▲   gate errors: retried within the attempt   │
  └──── feedback: failing criteria and asks ◀───┘
```

- **Gates** are code: `check`, the scene allowlist, `look`. They run in order, a gate only when the ones before it passed, and their errors go back to the author within the same attempt (up to 3). What a gate saw, like the reels' pictures, is evidence the reviewers get.
- **Reviewers** are other agents that never see the author's reasoning. Each grades against a rubric (`agents/<name>.rubric.json`): criteria with a weight and a threshold, 1–5, and graded examples that keep its scores where we set them. A round passes when every criterion meets its threshold.
- **Decide**: the loop stops when every criterion passes, when the score stops rising, when the rounds or the stage's budget run out, or when a revision or review fails. The last revision is always reviewed. The round kept is a passing one before a failing one, then the best score.

Every round goes to `trace/<stage>/` and its grades to `review.json`: read them to tune a prompt or a rubric. A project tunes the loop in `project.json`:

```json
"pipeline": { "reels": { "rounds": 3, "budgetUsd": 8, "parallel": 3, "reviewers": ["reader"], "gates": ["check", "look"] } }
```

A reviewer or gate left out of its list is off, except `check`, which never is. Each one is an assumption about what the author can't do alone; `daily-token replay reels --date D --set reels.reviewers=[]` makes the stage again in a scratch copy and prints its stop, scores and cost beside the first run's, so a component earns its place.

Agents run headless through the `claude` CLI (`src/harness/model.ts`), with no tools and no settings: their prompt is `agents/<name>.md` and their input is JSON. Locally that uses your Claude login; CI uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. The model is `opus` unless `AGENT_MODEL` or `MODEL_<AGENT>` (e.g. `MODEL_READER=sonnet`) says otherwise. Tests use a scripted model instead.

- **Writer** turns the day's data and the last five issues into `stories.json`. A made-up fixture issue shows it the shape. Gate: `check`. Reviewer: the **Editor**, on truth, coverage, grouping, plain words and style.
- **Directors** write `reels.json`, one thread each. Which threads there are is code: the week on a Thursday, then every story in the digest's order, then what's coming when PRs are open. Each thread is its own loop, `parallel` at a time (3), sharing the stage's `budgetUsd` in proportion to its `maxShorts`: its Director sees that story, its own slice of the data, and the other threads' titles, and makes as few shorts as the story allows (about one per two cards, at most 4; `maxShorts` overrides), the first stating the story's point, each caption and why within 30 words; a short is a template and its fields, or a scene it draws itself. Gates: `check` and `look` on that thread. Reviewers: the **Readers** (a teammate, a newcomer, a partner), who see a picture of every short as it ends and grade honesty, legibility, the thread's arc and whether every short earns its seconds (`tight`), calibrated by graded examples in `agents/reader.rubric.json`, so only a weak thread is revised. `review.json` keeps each thread's rounds and the score of the one kept (`keptScore`) under `reels.threads`, and `trace/reels/<thread>/` its drafts.
- **Explainer** writes `motion.json`, the [Cutaway](#the-cutaway)'s storyboard, when the run asks for one: `run` asks "Make a Cutaway for this edition? [y/N]" in a terminal; `--motion` or `--no-motion` decide without asking; otherwise (CI) `pipeline.motion.enabled` in `project.json` does, and it is off by default. It sees `pipeline.motion.topic` when set, the system map with its edges and groups, the brief, today's digest, its reels' headlines and data, and the flows of the last ten motions; it picks a flow across the system it hasn't toured lately, or no motion at all (`make: false`, which leaves no `motion.json`). Gates: `check` (the schema; every stop a part of `system.json` reached along an edge between the two or inside one frame; at least three parts crossed; every PR it marks new today in today's data, and at most half the stops marked, since walking through the news is the reels' job; a title that retells none of today's stories or reels; every number of two digits or more, every code name, path or identifier, and every word of a part's inside labels somewhere in the data, the digest, the system map or the brief; and its length 40–90 s as its words will be spoken; a flow toured in the last ten motions is a warning) and `render` (pictures of the opening map, three stops and the pull-back, which go to the reviewer). Reviewer: the **Viewer**, on how (could a newcomer explain it step by step, failures included), deep (several concrete steps per part), clear (Simplified Technical English), big picture, engaging (a question early, paid off at the end), fresh, honest and legible, calibrated by `agents/viewer.rubric.json`: a flat tour of where things go scores low, one that answers a question with the mechanism and its failure path scores high. Three rounds unless `pipeline.motion.rounds` says otherwise. `--from motion` and `replay motion` run it alone.
- **Cartographer** (`daily-token project cartographer`) is a project collector: it runs when you ask, not daily, and keeps `system.json`: parts, path globs, groups, edges and an `ignore` list. It reads the files recent issues found in no part and the repos' folder tree, and writes `system.proposed.json` with a note per change; `--accept` puts it in place. It decides meaning only. Same parts, groups and edges keep the drawn layout; any change to them redraws the map with [ELK](https://eclipse.dev/elk/) (`src/layout.ts`), top to bottom, so compare before accepting.
- **Briefer** (`daily-token project brief`) is a project collector too. It keeps `brief.json`: what the project is (`about`), the `names` of its pieces with their other names (`aka`), and the `terms` a newcomer won't know with plain words for each. It reads what the repos already say: READMEs, glossaries, overviews, architecture notes and `CLAUDE.md`/`AGENTS.md` up to three folders deep, and first the docs `project.json` lists in `brief.docs` (`owner/name:path`, or a path in the data root). Its gate refuses a name or term that appears in none of those docs or recent PRs. It writes `brief.proposed.json`; edit it if you like, then `--accept`. The brief is optional and hand-editable; with it, the Writer and Director call things by their names and the Editor and Readers grade plain words against it.

`look` (`src/look.ts`) opens the issue in a headless browser (Playwright: the Chrome the CI runner ships, your Chrome locally, or `LOOK_BROWSER=chrome|chromium`) and measures every reel at rest. Text on other text, or outside the 640×360 frame, is an error the Director must fix; text across a line is a warning, since every reel label wears a thin outline in the background color and lines pass behind it. A template marks a line that crosses text on purpose (a lifeline, a strike-through) `data-look="behind"`; scenes can't. It also takes the pictures the Readers get. `mise run check -- --look` adds it to a check; `bun src/look.ts --shots DIR` saves the pictures.

The bucket is the archive: `projects.json`, and per project every issue's JSON and HTML under `<project>/issues/` with its `index.json`, and beside a page the motion's video and poster. The Worker answers a video's range requests, which Safari needs to play it. The data root is the source: `publish` renders nothing itself, it makes R2 match the root and `out/` (run `render --all` first) and uploads only the files whose MD5 differs. `--announce DATE` also posts that issue to Slack.

### Formats

`data.json` has `format`, the shape of issue the templates and the player expect (`FORMAT` in `src/issue.ts`; none means 1), and `engine`, the version that collected it. Format 2 put each source's slice under `sources` and made cards and reels cite `ref`. Format 3 made reels threads: `migrate` groups an older issue's reels by their section and gives a story that had none a `title` short in its own words. A fix that old issues can take keeps the format, and every issue gets it on the next publish. A breaking change — a renamed field, a template that needs data old issues don't have — goes like this:

1. Tag the last commit of the old format: `git tag format-v1 && git push origin format-v1`.
2. Bump `FORMAT` and make the change.

`render` then sends every issue of an older format to the engine version its `data.json` names, installed once from npm in the temp directory; an issue with no version goes to the commit tagged `format-v<N>` when the engine is a git checkout. `daily-token migrate` converts them to the current format instead: same words, the current look.

## License

[AGPL-3.0](LICENSE). Running a changed engine as a service means publishing its source.
