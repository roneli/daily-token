import type { Ctx } from "./context";
import { minutes, took, usualTimes } from "./progress";

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
  // The stages this pass runs, and how long each usually takes, so a long run says how far it is.
  const due: Stage[] = [];
  for (const [i, stage] of stages.slice(0, to + 1).entries()) {
    if (i < from && (await Promise.all(stage.makes.map((f) => ctx.has(f)))).every(Boolean)) continue;
    due.push(stage);
  }
  const usual = await usualTimes(ctx.root, ctx.date);
  // A Cutaway counts only when this run makes one.
  const expect = (s: Stage) => (s.name === "motion" && !ctx.pipeline.motion?.enabled ? 0 : (usual[s.name] ?? 0));
  const log = ctx.log("run");
  const times: Record<string, number> = {};
  let stopped: string | undefined;
  for (const [k, stage] of due.entries()) {
    const left = due.slice(k).reduce((n, s) => n + expect(s), 0);
    log(`step ${k + 1} of ${due.length} · ${stage.name}${left ? ` · ${minutes(left)} left` : ""}`);
    const started = performance.now();
    const result = await stage.run(ctx);
    times[stage.name] = Math.round(performance.now() - started);
    log(`${stage.name} done in ${took(times[stage.name])}`);
    if (result === "stop") {
      stopped = stage.name;
      break;
    }
  }
  // A check from an earlier pass no longer describes the issue once any stage has run again.
  const { check: _stale, leftOut: _left, ...before } = (await ctx.has("meta.json")) ? await ctx.read<Record<string, unknown> & { runs?: Ctx["runs"]; reviews?: object; stages?: Record<string, number> }>("meta.json") : {};
  const cost = ctx.runs.reduce((n, r) => n + r.costUsd, 0);
  const meta: Record<string, unknown> = { ...before, ...ctx.meta, reviews: { ...before.reviews, ...(ctx.meta.reviews as object | undefined) }, stages: { ...before.stages, ...times }, date: ctx.date, from: opts.from ?? names[0], stopped, runs: [...(before.runs ?? []), ...ctx.runs], costUsd: Number(cost.toFixed(4)) };
  await ctx.write("meta.json", meta);
  return { stopped, costUsd: cost, meta };
}
