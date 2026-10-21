import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx } from "../harness/context";
import type { Gate, Reviewer } from "../harness/loop";
import { configured } from "../sources";
import { type Data, ENGINE, type GithubDay, type Issue, issueDates, type Ref, readJson, type Reels, type Short, shortsOf, type Stories, type Thread } from "../issue";

// What the agent stages share: the day as the agents see it, and the issue as check sees it.

export const FIXTURE = join(ENGINE, "fixtures", "sample", "issues");

// Long bodies and file lists cost tokens and say little more; parts carry the shape.
export function slim(data: Data): Data {
  const gh = data.sources.github;
  if (!gh) return data;
  const cap = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)} …` : s);
  const files = (f: string[]) => (f.length > 30 ? [...f.slice(0, 30), `… and ${f.length - 30} more`] : f);
  const github: GithubDay = {
    ...gh,
    prs: gh.prs.map((p) => ({ ...p, files: files(p.files), body: cap(p.body, 4000) ?? "" })),
    commits: gh.commits?.map((c) => ({ ...c, files: files(c.files), body: cap(c.body, 2000) ?? "" })),
    issues: gh.issues?.map((i) => ({ ...i, body: cap(i.body, 1500) ?? "" })),
    openPrs: gh.openPrs.map((o) => ({ ...o, body: cap(o.body, 1500) })),
  };
  return { ...data, sources: { ...data.sources, github } };
}

// Nothing landed: every configured source's slice is empty or missing.
export const quiet = (ctx: Ctx, data: Data) =>
  configured(ctx.project).every(({ source }) => data.sources[source.name] === undefined || source.empty(data.sources[source.name]));

export const day = (ctx: Ctx, data: Data) => ({
  project: ctx.project, ...(ctx.brief ? { brief: ctx.brief } : {}), date: ctx.date, edition: data.edition, data: slim(data),
  parts: ctx.system.parts.map((p) => ({ id: p.id, name: p.name, what: p.what })),
});

export const issueOf = (ctx: Ctx, data: Data, stories: Stories, threads: Thread[] = []): Issue => ({ root: ctx.root, dir: ctx.dir, project: ctx.project, data, stories, reels: { threads }, system: ctx.system });

// The last few issues' stories, so threads connect across days.
export async function previous(root: string, date: string) {
  const dates = (await issueDates(root)).filter((d) => d < date).slice(-5);
  const out = [];
  for (const d of dates) {
    const file = Bun.file(join(root, "issues", d, "stories.json"));
    if (!(await file.exists())) continue;
    const s = (await file.json()) as Stories;
    out.push({ date: d, headline: s.headline, sections: s.sections.map((x) => ({ id: x.id, story: x.story, title: x.title, cards: x.cards.map((c) => ({ ref: c.ref ?? (c as { pr?: Ref }).pr, headline: c.headline })) })) });
  }
  return out;
}

// Each reel template's schema and description, with a fixture short as its example.
export async function templates() {
  const examples: Short[] = [];
  for (const d of await readdir(FIXTURE)) examples.push(...shortsOf(await readJson<Reels>(join(FIXTURE, d, "reels.json"))).map(({ thread: _t, ...s }) => s));
  const dir = join(ENGINE, "templates", "reels");
  const out = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".schema.json")).sort()) {
    const name = f.replace(".schema.json", "");
    const schema = await readJson<{ description?: string }>(join(dir, f));
    out.push({ name, description: schema.description ?? "", schema, example: examples.find((r) => r.template === name) ?? null });
  }
  return { templates: out, sceneRules: await Bun.file(join(ENGINE, "agents", "scenes.md")).text() };
}

// The stage's gates and reviewers that project.json leaves on. check is never off: rule 1.
export function chosen<T>(ctx: Ctx, stage: string, gates: Gate<T>[], reviewers: Reviewer<T>[]) {
  const c = ctx.pipeline[stage] ?? {};
  for (const n of c.gates ?? []) if (!gates.some((g) => g.name === n)) throw new Error(`pipeline.${stage}.gates names ${n}; this stage has ${gates.map((g) => g.name).join(", ")}`);
  for (const n of c.reviewers ?? []) if (!reviewers.some((r) => r.agent === n)) throw new Error(`pipeline.${stage}.reviewers names ${n}; this stage has ${reviewers.map((r) => r.agent).join(", ")}`);
  return {
    gates: gates.filter((g) => g.name === "check" || !c.gates || c.gates.includes(g.name)),
    reviewers: reviewers.filter((r) => !c.reviewers || c.reviewers.includes(r.agent)),
    rounds: c.rounds ?? 3,
    budgetUsd: c.budgetUsd,
  };
}
