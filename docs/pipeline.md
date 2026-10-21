# The pipeline

```
collect ─▶ stories ─▶ reels ─▶ motion ─▶ verify
sources    Writer      Director   Explainer   check
           ⇄ Editor    ⇄ Readers  ⇄ Viewer
                                  (when asked)
```

`daily-token run --date D` runs the stages for one day (`src/pipeline.ts`). Each reads earlier stages' files from the issue folder and writes its own, so `--from STAGE` restarts there and keeps the files before it, and `--to STAGE` stops after one. A day where every source is empty makes no issue.

Scripts do what's deterministic: collect, links, quotes against PR bodies, the epic graph, `check`. Agents do what needs judgment, and each returns JSON against a schema. An agent is one folder, `agents/<name>/`: its `prompt.md`, and its `output.schema.json` or, for a reviewer, its `rubric.json`.

## The loop

Every agent stage is one loop, `refine` (`src/harness/loop.ts`):

```
author ─▶ gates ─▶ reviewers ─▶ decide ─┐
  ▲   gate errors: retried within the attempt   │
  └──── feedback: failing criteria and asks ◀───┘
```

- **Gates** are code: `check`, the scene allowlist, `look`. They run in order, a gate only when the ones before it passed, and their errors go back to the author within the same attempt (up to 3). What a gate saw, like the reels' pictures, is evidence the reviewers get.
- **Reviewers** are other agents that never see the author's reasoning. Each grades against a rubric (`agents/<name>/rubric.json`): criteria with a weight and a threshold, 1–5, and graded examples that keep its scores where we set them. A round passes when every criterion meets its threshold.
- **Decide**: the loop stops when every criterion passes, when the score stops rising, when the rounds or the stage's budget run out, or when a revision or review fails. The last revision is always reviewed. The round kept is a passing one before a failing one, then the best score.

Every round goes to `trace/<stage>/` and its grades to `review.json`: read them to tune a prompt or a rubric. A project tunes the loop in `project.json`:

```json
"pipeline": { "reels": { "rounds": 3, "budgetUsd": 8, "parallel": 3, "reviewers": ["reader"], "gates": ["check", "look"] } }
```

A reviewer or gate left out of its list is off, except `check`, which never is. Each one is an assumption about what the author can't do alone; `daily-token replay reels --date D --set reels.reviewers=[]` makes the stage again in a scratch copy and prints its stop, scores and cost beside the first run's, so a component earns its place.

Agents run headless through the `claude` CLI (`src/harness/model.ts`), with no tools and no settings: their prompt is `agents/<name>/prompt.md` and their input is JSON. Locally that uses your Claude login; CI uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. The model is `opus` unless `AGENT_MODEL` or `MODEL_<AGENT>` (e.g. `MODEL_READER=sonnet`) says otherwise. Tests use a scripted model instead.

- **Writer** turns the day's data and the last five issues into `stories.json`. A made-up fixture issue shows it the shape. Gate: `check`. Reviewer: the **Editor**, on truth, coverage, grouping, plain words and style.
- **Directors** write `reels.json`, one thread each. Which threads there are is code: the week on a Thursday, then every story in the digest's order, then what's coming when PRs are open. Each thread is its own loop, `parallel` at a time (3), sharing the stage's `budgetUsd` in proportion to its `maxShorts`: its Director sees that story, its own slice of the data, and the other threads' titles, and makes as few shorts as the story allows (about one per two cards, at most 4; `maxShorts` overrides), the first stating the story's point, each caption and why within 30 words; a short is a template and its fields, or a scene it draws itself. Gates: `check` and `look` on that thread. Reviewers: the **Readers** (a teammate, a newcomer, a partner), who see a picture of every short as it ends and grade honesty, legibility, the thread's arc and whether every short earns its seconds (`tight`), calibrated by graded examples in `agents/reader/rubric.json`, so only a weak thread is revised. `review.json` keeps each thread's rounds and the score of the one kept (`keptScore`) under `reels.threads`, and `trace/reels/<thread>/` its drafts.
- **Explainer** writes `motion.json`, the [Cutaway](cutaway.md)'s storyboard, when the run asks for one: `run` asks "Make a Cutaway for this edition? [y/N]" in a terminal; `--motion` or `--no-motion` decide without asking; otherwise (CI) `pipeline.motion.enabled` in `project.json` does, and it is off by default. It sees `pipeline.motion.topic` when set, the system map with its edges and groups, the brief, today's digest, its reels' headlines and data, and the flows of the last ten motions; it picks a flow across the system it hasn't toured lately, or no motion at all (`make: false`, which leaves no `motion.json`). Gates: `check` (the schema; every stop a part of `system.json` reached along an edge between the two or inside one frame; at least three parts crossed; every PR it marks new today in today's data, and at most half the stops marked, since walking through the news is the reels' job; a title that retells none of today's stories or reels; every number of two digits or more, every code name, path or identifier, and every word of a part's inside labels somewhere in the data, the digest, the system map or the brief; and its length 40–90 s as its words will be spoken; a flow toured in the last ten motions is a warning) and `render` (pictures of the opening map, three stops and the pull-back, which go to the reviewer). Reviewer: the **Viewer**, on how (could a newcomer explain it step by step, failures included), deep (several concrete steps per part), clear (Simplified Technical English), big picture, engaging (a question early, paid off at the end), fresh, honest and legible, calibrated by `agents/viewer/rubric.json`: a flat tour of where things go scores low, one that answers a question with the mechanism and its failure path scores high. Three rounds unless `pipeline.motion.rounds` says otherwise. `--from motion` and `replay motion` run it alone.
- **Cartographer** (`daily-token project cartographer`) is a project collector: it runs when you ask, not daily, and keeps `system.json`: parts, path globs, groups, edges and an `ignore` list. It reads the files recent issues found in no part and the repos' folder tree, and writes `system.proposed.json` with a note per change; `--accept` puts it in place. It decides meaning only. Same parts, groups and edges keep the drawn layout; any change to them redraws the map with [ELK](https://eclipse.dev/elk/) (`src/layout.ts`), top to bottom, so compare before accepting.
- **Briefer** (`daily-token project brief`) is a project collector too. It keeps `brief.json`: what the project is (`about`), the `names` of its pieces with their other names (`aka`), and the `terms` a newcomer won't know with plain words for each. It reads what the repos already say: READMEs, glossaries, overviews, architecture notes and `CLAUDE.md`/`AGENTS.md` up to three folders deep, and first the docs `project.json` lists in `brief.docs` (`owner/name:path`, or a path in the data root). Its gate refuses a name or term that appears in none of those docs or recent PRs. It writes `brief.proposed.json`; edit it if you like, then `--accept`. The brief is optional and hand-editable; with it, the Writer and Director call things by their names and the Editor and Readers grade plain words against it.

`look` (`src/look.ts`) opens the issue in a headless browser (Playwright: the Chrome the CI runner ships, your Chrome locally, or `LOOK_BROWSER=chrome|chromium`) and measures every reel at rest. Text on other text, or outside the 640×360 frame, is an error the Director must fix; text across a line is a warning, since every reel label wears a thin outline in the background color and lines pass behind it. A template marks a line that crosses text on purpose (a lifeline, a strike-through) `data-look="behind"`; scenes can't. It also takes the pictures the Readers get. `mise run check -- --look` adds it to a check; `bun src/look.ts --shots DIR` saves the pictures.

The bucket is the archive: `projects.json`, and per project every issue's JSON and HTML under `<project>/issues/` with its `index.json`, and beside a page the motion's video and poster. The Worker answers a video's range requests, which Safari needs to play it. The data root is the source: `publish` renders nothing itself, it makes R2 match the root and `out/` (run `render --all` first) and uploads only the files whose MD5 differs. `--announce DATE` also posts that issue to Slack.

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
