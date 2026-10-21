import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Brief, readBrief } from "../brief";
import { type Project, readJson, type System, writeJson } from "../issue";
import type { Round } from "./loop";
import type { Model, Run } from "./model";
import { errorsOf, load } from "./schema";

// How a project tunes a stage, in project.json "pipeline": { "<stage>": { ... } }.
// A reviewer or gate left out of its list is switched off; without a list, all of them run.
export type StageConfig = NonNullable<Project["pipeline"]>[string];

// Everything a stage gets: the day, the project, the model, and the issue folder it reads and writes.
// Stages talk to each other only through files in that folder, so a run can restart at any stage.
export type Ctx = {
  root: string;
  date: string;
  tz: string;
  cutoff: string;
  dir: string;
  project: Project;
  system: System;
  // What the project is and what its words mean, when the data root has a brief.json.
  brief?: Brief;
  model: Model;
  pipeline: Record<string, StageConfig>;
  at(file: string): string;
  has(file: string): Promise<boolean>;
  read<T>(file: string): Promise<T>;
  write(file: string, value: unknown): Promise<unknown>;
  log(stage: string): (msg: string) => void;
  trace(stage: string): (name: string, value: unknown) => Promise<unknown>;
  // Keeps a refine's rounds in review.json and its summary in meta.json.
  graded(stage: string, r: { stop: string; rounds: Round<unknown>[]; runs: Run[] }): Promise<void>;
  // The same for a stage made of threads, each its own refine: each thread's rounds, and the stage's summary.
  gradedThreads(stage: string, threads: [id: string, r: { stop: string; rounds: Round<unknown>[]; runs: Run[]; value: unknown }][]): Promise<void>;
  // Every agent run of this pass, and what stages add to meta.json.
  runs: Run[];
  meta: Record<string, unknown>;
};

export type CtxOpts = { root: string; date: string; tz: string; cutoff: string; model: Model; set?: Record<string, StageConfig> };

export async function createCtx(o: CtxOpts): Promise<Ctx> {
  const dir = join(o.root, "issues", o.date);
  await mkdir(dir, { recursive: true });
  const [project, system, brief] = await Promise.all([readJson<Project>(join(o.root, "project.json")), readJson<System>(join(o.root, "system.json")), readBrief(o.root)]);
  const pipeline: Record<string, StageConfig> = { ...project.pipeline };
  for (const [stage, c] of Object.entries(o.set ?? {})) pipeline[stage] = { ...pipeline[stage], ...c };
  // --set skips project.json's schema; the merged config gets the same check.
  const errors = errorsOf((await load("project")) as object, { ...project, pipeline }, "project");
  if (errors.length) throw new Error(`pipeline config: ${errors.join("; ")}`);
  const at = (file: string) => join(dir, file);
  const ctx: Ctx = {
    root: o.root, date: o.date, tz: o.tz, cutoff: o.cutoff, dir, project, system, brief, model: o.model, pipeline,
    at,
    has: (file) => Bun.file(at(file)).exists(),
    read: (file) => readJson(at(file)),
    write: (file, value) => writeJson(at(file), value),
    log: (stage) => (msg) => console.log(`[${stage}] ${msg}`),
    trace: (stage) => (name, value) => writeJson(at(join("trace", stage, `${name}.json`)), value),
    async graded(stage, r) {
      // review.json keeps each stage's rounds, scores and why it stopped; a restart replaces only the stages it reran.
      const before = (await ctx.has("review.json")) ? await ctx.read<Record<string, unknown>>("review.json") : {};
      const rounds = r.rounds.map(({ n, score, passed, reviews }) => ({ n, score, passed, reviews }));
      const costUsd = Number(r.runs.reduce((n, x) => n + x.costUsd, 0).toFixed(4));
      await ctx.write("review.json", { ...before, [stage]: { stop: r.stop, costUsd, rounds } });
      ctx.meta.reviews = { ...(ctx.meta.reviews as object), [stage]: { stop: r.stop, scores: rounds.map((x) => x.score), costUsd } };
    },
    async gradedThreads(stage, threads) {
      const before = (await ctx.has("review.json")) ? await ctx.read<Record<string, unknown>>("review.json") : {};
      const each = threads.map(([id, r]) => {
        const kept = r.rounds.find((x) => x.value === r.value);
        return { id, stop: r.stop, costUsd: Number(r.runs.reduce((n, x) => n + x.costUsd, 0).toFixed(4)), keptScore: kept?.score ?? null, rounds: r.rounds.map(({ n, score, passed, reviews }) => ({ n, score, passed, reviews })) };
      });
      const costUsd = Number(each.reduce((n, t) => n + t.costUsd, 0).toFixed(4));
      const scored = each.filter((t) => t.keptScore !== null);
      // The stage's one score is the mean of what each thread kept, so replay can set it beside an earlier run's.
      const score = scored.length ? Number((scored.reduce((n, t) => n + (t.keptScore ?? 0), 0) / scored.length).toFixed(4)) : null;
      const stop = each.every((t) => t.stop === "passed") ? "passed" : "partly";
      await ctx.write("review.json", { ...before, [stage]: { stop, costUsd, rounds: [{ n: 1, score }], threads: Object.fromEntries(each.map(({ id, ...t }) => [id, t])) } });
      ctx.meta.reviews = { ...(ctx.meta.reviews as object), [stage]: { stop, score, costUsd, threads: Object.fromEntries(each.map((t) => [t.id, { stop: t.stop, scores: t.rounds.map((x) => x.score), costUsd: t.costUsd }])) } };
    },
    runs: [],
    meta: {},
  };
  return ctx;
}
