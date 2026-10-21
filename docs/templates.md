# Templates

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

## Scenes and animation marks

A reel can be a template or a `scene`: SVG the Director draws itself, held to an allowlist. Both animate with `data-anim` and `data-cue` marks. The rules and the marks are in [agents/scenes.md](../agents/scenes.md), which the Director reads as written.

## Reel templates

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
