import type { Ctx } from "./context";

// A stage reads earlier stages' files from the issue folder and writes its own. `makes` lists the ones that
// mean it ran: an issue from before a stage wrote some new file still counts as done.
// "stop" ends the run early, e.g. a day where nothing landed.
export type Stage = { name: string; makes: string[]; run(ctx: Ctx): Promise<unknown> };

// Runs the stages from `from` through `to`. An earlier stage is skipped while its files are there, and runs
// again when one is missing. meta.json keeps every pass's runs, so a restart adds to the record.
export async function run(ctx: Ctx, stages: Stage[], opts: { from?: string; to?: string } = {}) {
  const names = stages.map((s) => s.name);
  for (const n of [opts.from, opts.to]) if (n !== undefined && !names.includes(n)) throw new Error(`no stage ${n}; the stages are ${names.join(", ")}`);
  const from = opts.from ? names.indexOf(opts.from) : 0;
  const to = opts.to ? names.indexOf(opts.to) : names.length - 1;
  if (from > to) throw new Error(`--from ${opts.from} comes after --to ${opts.to}`);
  let stopped: string | undefined;
  for (const [i, stage] of stages.slice(0, to + 1).entries()) {
    if (i < from && (await Promise.all(stage.makes.map((f) => ctx.has(f)))).every(Boolean)) continue;
    if ((await stage.run(ctx)) === "stop") {
      stopped = stage.name;
      break;
    }
  }
  // A check from an earlier pass no longer describes the issue once any stage has run again.
  const { check: _stale, leftOut: _left, ...before } = (await ctx.has("meta.json")) ? await ctx.read<Record<string, unknown> & { runs?: Ctx["runs"]; reviews?: object }>("meta.json") : {};
  const cost = ctx.runs.reduce((n, r) => n + r.costUsd, 0);
  const meta: Record<string, unknown> = { ...before, ...ctx.meta, reviews: { ...before.reviews, ...(ctx.meta.reviews as object | undefined) }, date: ctx.date, from: opts.from ?? names[0], stopped, runs: [...(before.runs ?? []), ...ctx.runs], costUsd: Number(cost.toFixed(4)) };
  await ctx.write("meta.json", meta);
  return { stopped, costUsd: cost, meta };
}
