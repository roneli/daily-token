import { join } from "node:path";
import { issueDates } from "../issue";

// How long each stage usually takes, from the last issues' meta.json: the stage times a run records, or for an
// issue from before those, its agents' times, a stage's agents being its author and reviewers.

const AGENTS: Record<string, string> = { writer: "stories", editor: "stories", director: "reels", reader: "reels", explainer: "motion", viewer: "motion" };
// Reels run their threads a few at a time, so their agents' times add up to more than the stage took.
const AT_ONCE: Record<string, number> = { reels: 3 };
const LOOK_BACK = 5;
// Until a stage has been timed here, a first guess from runs elsewhere: a Cutaway is reviewed, voiced and filmed.
const FIRST_GUESS: Record<string, number> = { collect: 60_000, stories: 240_000, reels: 240_000, motion: 600_000, verify: 30_000 };

type Meta = { stages?: Record<string, number>; runs?: { agent: string; ms: number }[] };

export function stageTimes(meta: Meta): Record<string, number> {
  if (meta.stages) return meta.stages;
  const out: Record<string, number> = {};
  for (const r of meta.runs ?? []) {
    const stage = AGENTS[r.agent];
    if (stage) out[stage] = (out[stage] ?? 0) + r.ms;
  }
  for (const [stage, n] of Object.entries(AT_ONCE)) if (out[stage]) out[stage] /= n;
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};

// Each stage's usual time over the issues before `date`; a stage none of them timed gets its first guess.
export async function usualTimes(root: string, date: string): Promise<Record<string, number>> {
  const metas: Meta[] = [];
  for (const d of (await issueDates(root)).filter((x) => x < date).slice(-LOOK_BACK)) {
    const file = Bun.file(join(root, "issues", d, "meta.json"));
    if (await file.exists()) metas.push((await file.json()) as Meta);
  }
  const times = metas.map(stageTimes);
  const stages = new Set(times.flatMap((t) => Object.keys(t)));
  const out: Record<string, number> = { ...FIRST_GUESS };
  for (const s of stages) {
    const m = median(times.map((t) => t[s]).filter((x): x is number => x !== undefined));
    if (m !== undefined) out[s] = m;
  }
  return out;
}

export const minutes = (ms: number) => {
  if (ms < 60_000) return "under a minute";
  const m = Math.round(ms / 60_000);
  return `about ${m} min`;
};

export const took = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
