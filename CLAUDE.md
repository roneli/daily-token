# CLAUDE.md

Short sentences. RFC 2119 keywords for obligations. Commit = imperative subject; body only for a fact the diff cannot show. Comments only where code needs clarification.

## Rules

1. **Data is the truth.** Every PR number, count and quote in an issue MUST come from `data.json` or a PR body it holds. `check` enforces this; don't weaken it to make an issue pass.
2. **Templates hold no code.** `.liquid` files are HTML with placeholders and animation marks. Logic a template needs goes in its `layout.ts`, which our code owns.
3. **Agents fill fields; only the Director draws.** The Digest, the Blueprint and the Cutaway's motion are fixed templates filled from JSON; the motion's map, camera and timing are worked out in `templates/motion/tour.layout.ts`, and its moves drawn by `templates/motion/moves.ts`, which our code owns. A motion stop MAY instead compose a `free` beat from those primitives as JSON on a grid of slots, never SVG or coordinates, checked by `checkMotion`. A reel MAY instead be a `scene`: SVG the Director writes, checked by `src/scene.ts` against an allowlist and re-serialized from the parsed tree. Widen the allowlist only with a refusal test for what stays out.
4. **A short is one idea, 6–12 s.** Every story gets a thread of 1–4 shorts, about one per two cards; fewer is better. A short's caption and why hold at most 30 words. Past 45 s a thread warns in `check`, and so does an issue with more threads than its story cap (`pipeline.stories.maxStories`, 6 by default, at most 12) plus recap and next.
5. **Plain words up front, detail under the hood.** Card headlines and `plain` text are for someone who doesn't read the code. Paths, flags and test names go in `tech`.
6. **Pin versions** at releases at least two weeks old. Prefer tested libraries to hand-rolled code.
7. **Lint is fixed, not suppressed.** `mise run lint` stays clean.
8. **An issue's words don't change; its look follows the engine.** Every publish renders every issue again from its JSON. Assets are content-hashed. A breaking change to what the templates or the player expect bumps `FORMAT` in `src/issue.ts` and tags the last commit of the old format `format-v<N>`.
9. **The engine knows no repo.** A project's specifics live in its data root (`project.json`, `system.json`) and env (`DIGEST_TZ`, `CUTOFF`). Code and fixtures MUST NOT name a real repo, path or person.
