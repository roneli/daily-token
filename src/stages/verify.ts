import type { Storyboard } from "../motion";
import { check } from "../check";
import type { Stage } from "../harness/runner";
import { type Data, type Reels, type Stories, shortsOf } from "../issue";
import { issueOf } from "./day";

// The whole issue, checked once more as it will be published.
export const verifyStage: Stage = {
  name: "verify",
  makes: [],
  async run(ctx) {
    const [data, stories, reels] = await Promise.all([ctx.read<Data>("data.json"), ctx.read<Stories>("stories.json"), ctx.read<Reels>("reels.json")]);
    const motion = (await ctx.has("motion.json")) ? await ctx.read<Storyboard>("motion.json") : undefined;
    const final = await check({ ...issueOf(ctx, data, stories, reels.threads), ...(motion ? { motion } : {}) });
    ctx.meta.check = final;
    for (const w of final.warnings) console.warn(`warn  ${w}`);
    for (const e of final.errors) console.error(`error ${e}`);
    ctx.log("verify")(`${final.errors.length ? "issue fails check" : "issue ready"}: ${reels.threads.length} threads, ${shortsOf(reels).length} shorts → ${ctx.dir}`);
  },
};
