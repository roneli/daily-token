import type { Stage } from "../harness/runner";
import { type Data, engineVersion, FORMAT, issueDates } from "../issue";
import { configured } from "../sources";
import { weekdayOf, window } from "../time";

// What every issue has, then each source's slice of the day under data.sources.<name>.
export const collectStage: Stage = {
  name: "collect",
  makes: ["data.json"],
  async run(ctx) {
    const earlier = (await issueDates(ctx.root)).filter((d) => d < ctx.date);
    const sources: Record<string, unknown> = {};
    for (const { source, config } of configured(ctx.project)) {
      sources[source.name] = await source.collect(ctx, config);
      ctx.log("collect")(`${source.name}: ${source.summary?.(sources[source.name]) ?? "collected"}`);
    }
    const data: Data = {
      format: FORMAT,
      engine: await engineVersion(),
      edition: weekdayOf(ctx.date) === ctx.project.weekly ? "weekly" : "daily",
      issue: earlier.length + 1,
      date: ctx.date,
      window: window(ctx.date, ctx.cutoff, ctx.tz, ctx.project.days),
      sources,
    };
    await ctx.write("data.json", data);
  },
};
