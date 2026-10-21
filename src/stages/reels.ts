import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "../check";
import type { Ctx } from "../harness/context";
import { type Gate, refine, type Reviewer } from "../harness/loop";
import { loadRubric } from "../harness/rubric";
import type { Stage } from "../harness/runner";
import { agentSchema } from "../harness/schema";
import { commitRef, type Data, githubOf, type Ref, refOf, reposOf, type Section, type Short, type Stories, type Thread } from "../issue";
import { look } from "../look";
import { chosen, issueOf, slim, templates } from "./day";

type Look = Awaited<ReturnType<typeof look>>;
type Cut = { name: string; shorts: Short[] };
// A thread to make: a story's, the week's, or what's coming.
export type Planned = { id: string; kind: "story" | "recap" | "next"; title: string; section?: Section; maxShorts: number };

// What a short's caption and why may hold together.
const WORDS = 30;
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

// Which threads the day has follows from the stories, so it is code: the week first on a Thursday, then every
// story in the digest's order, then what's coming when anything is open.
export function plan(stories: Stories, data: Data, max?: number): Planned[] {
  const threads: Planned[] = [];
  // A story earns about one short per two cards; the leftovers ("other") get one, the week and what's coming two.
  const shortsFor = (s: Section) => max ?? (s.id === "other" ? 1 : Math.min(4, Math.max(1, Math.ceil(s.cards.length / 2))));
  if (stories.recap) threads.push({ id: "recap", kind: "recap", title: stories.recap.title, maxShorts: max ?? 2 });
  for (const s of stories.sections) threads.push({ id: s.id, kind: "story", title: s.title, section: s, maxShorts: shortsFor(s) });
  if (githubOf(data).openPrs.length) threads.push({ id: "next", kind: "next", title: "What's coming", maxShorts: max ?? 2 });
  return threads;
}

// The slice of the day one Director needs: a story's own PRs and commits, the week and today's PR titles for the
// recap, the open work for what's coming. Epics and tags stay: they place any story.
export function sliceFor(t: Planned, data: Data, home: string): Data {
  const day = slim(data);
  const gh = githubOf(day);
  const cited = new Set<Ref>(t.section?.cards.flatMap((c) => [c.ref, ...(c.with ?? [])]) ?? []);
  const titles = gh.openPrs.map(({ body: _b, ...o }) => o);
  const github = {
    ...gh,
    prs: t.kind === "recap" ? gh.prs.map((p) => ({ ...p, body: "", files: [] })) : gh.prs.filter((p) => cited.has(refOf(p.repo, p.number, home))),
    commits: gh.commits?.filter((c) => cited.has(commitRef(c.repo, c.sha, home))),
    issues: t.kind === "next" ? gh.issues : gh.issues?.filter((i) => i.closedBy !== null && cited.has(i.closedBy)),
    openPrs: t.kind === "next" ? gh.openPrs : titles,
    week: t.kind === "recap" ? gh.week : undefined,
  };
  return { ...day, sources: { ...day.sources, github } };
}

// At most n at once, in order; every one runs to the end before the first failure is thrown.
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: PromiseSettledResult<R>[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).then((value) => ({ status: "fulfilled", value }) as const, (reason) => ({ status: "rejected", reason }) as const);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  const failed = out.find((r) => r.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return out.map((r) => (r as PromiseFulfilledResult<R>).value);
}

// One Director makes one thread; check and look gate it alone; the Readers grade it alone.
async function thread(ctx: Ctx, t: Planned, all: Planned[], data: Data, stories: Stories, shared: { input: Record<string, unknown>; budgetUsd?: number }) {
  const asThread = (cut: Cut): Thread => ({ id: t.id, name: cut.name, shorts: cut.shorts });
  const gates: Gate<Cut>[] = [
    {
      name: "check",
      run: async (cut) => {
        const errors = (await check(issueOf(ctx, data, stories, [asThread(cut)]), "thread")).errors;
        // Ids are shared by every reel on the page, and the threads are made apart.
        for (const s of cut.shorts) if (!s.id.startsWith(`${t.id}-`)) errors.push(`reel ${s.id}: a short's id starts with its thread's, "${t.id}-"`);
        if (cut.shorts.length > t.maxShorts) errors.push(`thread ${t.id}: ${cut.shorts.length} shorts; this story gets at most ${t.maxShorts}`);
        // Read in seconds on a phone: the detail belongs in the digest card.
        for (const s of cut.shorts) if (words(`${s.caption} ${s.why}`) > WORDS) errors.push(`reel ${s.id}: caption and why have ${words(`${s.caption} ${s.why}`)} words; at most ${WORDS}`);
        return { errors };
      },
    },
    // Only a thread that passes check is worth a browser: then text on text or out of frame goes back as errors too.
    {
      name: "look",
      run: async (cut) => {
        const seen = await look(issueOf(ctx, data, stories, [asThread(cut)]), { shots: await mkdtemp(join(tmpdir(), "daily-shots-")) });
        return { errors: seen.findings.filter((f) => f.level === "error").map((f) => `reel ${f.reel}: ${f.detail}`), evidence: seen };
      },
    },
  ];
  // The Readers see each short's picture, in order, beside its fields, and the story it tells.
  const reviewers: Reviewer<Cut>[] = [
    {
      agent: "reader",
      rubric: await loadRubric("reader"),
      show: (cut, evidence) => {
        const seen = (evidence.look as Look | undefined) ?? { findings: [], shots: [] };
        return {
          input: {
            ...(ctx.brief ? { brief: ctx.brief } : {}),
            thread: { id: t.id, kind: t.kind, title: t.title, name: cut.name, maxShorts: t.maxShorts, ...(t.section ? { story: { dek: t.section.dek, cards: t.section.cards.map((c) => ({ ref: c.ref, headline: c.headline, plain: c.plain })) } } : {}) },
            otherThreads: all.filter((o) => o.id !== t.id).map((o) => o.title),
            shorts: cut.shorts,
            pictures: seen.shots.map((s) => s.reel),
            layoutWarnings: seen.findings.map((f) => `reel ${f.reel}: ${f.detail}`),
          },
          images: seen.shots.map((s) => s.path),
        };
      },
    },
  ];
  const home = reposOf(ctx.project)[0];
  const input = {
    ...shared.input,
    thread: { id: t.id, kind: t.kind, title: t.title, idPrefix: `${t.id}-`, maxShorts: t.maxShorts },
    ...(t.section ? { story: t.section } : {}),
    ...(t.kind === "recap" ? { recap: stories.recap } : {}),
    issue: { headline: stories.headline, threads: all.map((o) => ({ id: o.id, title: o.title })) },
    data: sliceFor(t, data, home),
  };
  const config = chosen(ctx, "reels", gates, reviewers);
  return refine<Cut>({
    model: ctx.model, author: "director", input, schema: await agentSchema("director"),
    ...config, budgetUsd: shared.budgetUsd, trace: ctx.trace(`reels/${t.id}`), log: ctx.log(`reels:${t.id}`),
  });
}

// A thread per story, each made by its own Director, several at once.
export const reelsStage: Stage = {
  name: "reels",
  makes: ["reels.json"],
  async run(ctx) {
    const [data, stories] = await Promise.all([ctx.read<Data>("data.json"), ctx.read<Stories>("stories.json")]);
    const c = ctx.pipeline.reels ?? {};
    const planned = plan(stories, data, c.maxShorts);
    const input = { ...(ctx.brief ? { brief: ctx.brief } : {}), ...(await templates()) };
    // A bigger story may take more shorts, and more rounds to get them right: the budget follows maxShorts.
    const weight = planned.reduce((n, t) => n + t.maxShorts, 0);
    const made = await pool(planned, c.parallel ?? 3, (t) => thread(ctx, t, planned, data, stories, { input, budgetUsd: c.budgetUsd === undefined ? undefined : (c.budgetUsd * t.maxShorts) / weight }));
    for (const r of made) ctx.runs.push(...r.runs);
    await ctx.gradedThreads("reels", planned.map((t, i) => [t.id, made[i]]));
    await ctx.write("reels.json", { threads: planned.map((t, i) => ({ id: t.id, name: made[i].value.name, shorts: made[i].value.shorts })) });
  },
};
