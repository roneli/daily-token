import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCtx, type StageConfig } from "./harness/context";
import type { Model } from "./harness/model";
import { run } from "./harness/runner";
import { issueDates } from "./issue";
import { daily } from "./pipeline";

// replay: one stage of a past issue made again in a scratch root, beside how it went the first time.
// It is how a reviewer, a gate or a round gets measured before it is kept or dropped.
// The scratch root links to the real project and earlier issues; only the replayed issue is a copy.

export type Graded = { stop: string; costUsd?: number; rounds: { score: number | null }[] };

export async function replay(o: { root: string; date: string; stage: string; set: Record<string, StageConfig>; model: Model; tz?: string; cutoff?: string }) {
  if (!daily.some((s) => s.name === o.stage)) throw new Error(`no stage ${o.stage}; the stages are ${daily.map((s) => s.name).join(", ")}`);
  const root = resolve(o.root);
  const scratch = await mkdtemp(join(tmpdir(), `daily-replay-${o.stage}-`));
  for (const f of await readdir(root)) if (f !== "issues") await symlink(join(root, f), join(scratch, f));
  await mkdir(join(scratch, "issues"));
  for (const d of await issueDates(root)) if (d !== o.date) await symlink(join(root, "issues", d), join(scratch, "issues", d));
  const from = join(root, "issues", o.date);
  await cp(from, join(scratch, "issues", o.date), { recursive: true, filter: (src) => !src.startsWith(join(from, "trace")) && !src.endsWith("meta.json") });

  // The stage's first result stays in the real issue; the scratch copy starts without it, so a stage that grades
  // nothing shows nothing rather than the first run.
  const review = join(scratch, "issues", o.date, "review.json");
  if (await Bun.file(review).exists()) {
    const { [o.stage]: _first, ...rest } = (await Bun.file(review).json()) as Record<string, unknown>;
    await Bun.write(review, JSON.stringify(rest));
  }
  // Replaying the motion means making one, whatever project.json says.
  const set = o.stage === "motion" ? { ...o.set, motion: { enabled: true, ...o.set.motion } } : o.set;
  const ctx = await createCtx({ root: scratch, date: o.date, tz: o.tz ?? "UTC", cutoff: o.cutoff ?? "00:00", model: o.model, set });
  const result = await run(ctx, daily, { from: o.stage, to: o.stage });
  const graded = async (dir: string) => {
    const file = Bun.file(join(dir, "review.json"));
    return (await file.exists()) ? ((await file.json()) as Record<string, Graded>)[o.stage] : undefined;
  };
  return { scratch: ctx.dir, before: await graded(from), after: await graded(ctx.dir), costUsd: result.costUsd };
}

export function table(stage: string, set: string[], before: Graded | undefined, after: Graded | undefined) {
  const scores = (g?: Graded) => (g ? g.rounds.map((r) => (r.score === null ? "—" : r.score.toFixed(2))).join(" → ") : "—");
  const rows = [
    ["", "first time", `replay${set.length ? ` (${set.join(", ")})` : ""}`],
    ["stop", before?.stop ?? "—", after?.stop ?? "—"],
    ["rounds", String(before?.rounds.length ?? "—"), String(after?.rounds.length ?? "—")],
    ["scores", scores(before), scores(after)],
    ["cost", before?.costUsd === undefined ? "—" : `$${before.costUsd.toFixed(2)}`, after?.costUsd === undefined ? "—" : `$${after.costUsd.toFixed(2)}`],
  ];
  const w = [8, Math.max(...rows.map((r) => r[1].length)) + 2];
  return [stage, ...rows.map((r) => `  ${r[0].padEnd(w[0])}${r[1].padEnd(w[1])}${r[2]}`)].join("\n");
}
