# An issue

A data root is one **project**: one digest across one or more sources. Commands find it in the current folder, or in `DATA_DIR`, or `--root`. Every issue is a folder of JSON in it. Every publish renders every issue's HTML again from that JSON, so a template or player fix reaches the whole archive (see [Formats](issue.md#formats)). Without `DATA_DIR`, every command uses the made-up fixture in `fixtures/sample` (the project Rocket: `acme/rocket` and `acme/ground`).

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

## Formats

`data.json` has `format`, the shape of issue the templates and the player expect (`FORMAT` in `src/issue.ts`; none means 1), and `engine`, the version that collected it. Format 2 put each source's slice under `sources` and made cards and reels cite `ref`. Format 3 made reels threads: `migrate` groups an older issue's reels by their section and gives a story that had none a `title` short in its own words. A fix that old issues can take keeps the format, and every issue gets it on the next publish. A breaking change — a renamed field, a template that needs data old issues don't have — goes like this:

1. Tag the last commit of the old format: `git tag format-v1 && git push origin format-v1`.
2. Bump `FORMAT` and make the change.

`render` then sends every issue of an older format to the engine version its `data.json` names, installed once from npm in the temp directory; an issue with no version goes to the commit tagged `format-v<N>` when the engine is a git checkout. `daily-token migrate` converts them to the current format instead: same words, the current look.
