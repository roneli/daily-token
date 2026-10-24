# Commands

`daily-token <command>` (`bun src/cli.ts` in this repo; `daily-token help` lists them):

```
init      [DIR] [--yes --name --repos a/b,c/d --tz --cutoff --days --model --publish none|s3]
run       [--date D] [--from STAGE] [--to STAGE] [--rounds N] [--set stage.key=value] [--motion | --no-motion]
cutaway   "TOPIC" [--date D] [--force]: the Cutaway alone on the latest issue, touring that topic
replay    STAGE --date D [--set stage.key=value]
project   cartographer [--days N] [--accept]
project   brief [--days N] [--accept]
collect   [--date D] [--force]
render    [--date D | --all]
check     [--date D] [--look]
publish   [--announce D] [--dry-run]
preview   render every issue and serve out/ on :5173
serve     [--port 8787] [--host 127.0.0.1]: the site, from the issues bucket
github-app [--site URL] [--org NAME]: make the GitHub App readers sign in with, its keys into .env
deploy    [--dry-run]: the bucket and the site on Cloudflare, from .env
home      DIR [--dry-run]: the folder's index.html and files as the bare domain's front page
doctor    is the data root ready
migrate   [--dry-run]: bring a data root to the current format
```

The mise tasks run the same commands on this repo: `mise run issue`, `map`, `collect`, `render`, `check`, `preview`, `publish`, `serve`, `lint`, `test`, `worker:dev`, `worker:deploy`.

`check` warns when a thread runs past 45 s or an issue has more than 8 threads; with `--look` it also measures the reels in a browser. It fails when a cited PR or commit isn't in `data.json`, one landed with no card covering it, a story has no thread, two shorts share an id, a part isn't in `system.json` or has no box, a short runs over 12 s, a cue points at nothing, or a field breaks its schema.
