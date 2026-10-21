import { join } from "node:path";
import { check } from "../check";
import { type Gate, refine, type Reviewer } from "../harness/loop";
import { loadRubric } from "../harness/rubric";
import type { Stage } from "../harness/runner";
import { load } from "../harness/schema";
import { type Data, readJson, type Stories } from "../issue";
import { chosen, day, FIXTURE, issueOf, previous, quiet } from "./day";

// The Writer drafts the Digest; check gates it; the Editor grades it.
export const storiesStage: Stage = {
  name: "stories",
  makes: ["stories.json"],
  async run(ctx) {
    const data = await ctx.read<Data>("data.json");
    if (quiet(ctx, data)) {
      ctx.log("stories")("nothing landed in the window; no issue today");
      return "stop";
    }
    const today = day(ctx, data);
    const gates: Gate<Stories>[] = [{ name: "check", run: async (s) => ({ errors: (await check(issueOf(ctx, data, s), "stories")).errors }) }];
    const reviewers: Reviewer<Stories>[] = [{ agent: "editor", rubric: await loadRubric("editor"), show: (stories) => ({ input: { ...today, stories } }) }];
    const example = await readJson<Stories>(join(FIXTURE, "2026-01-15", "stories.json"));
    const r = await refine<Stories>({
      model: ctx.model, author: "writer", input: { ...today, previous: await previous(ctx.root, ctx.date), example }, schema: await load("stories"),
      ...chosen(ctx, "stories", gates, reviewers), trace: ctx.trace("stories"), log: ctx.log("stories"),
    });
    ctx.runs.push(...r.runs);
    await ctx.graded("stories", r);
    await ctx.write("stories.json", r.value);
  },
};
