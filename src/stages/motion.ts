import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMotion, type Recent } from "../check";
import { type Excerpt, type Reader, readRepos } from "../excerpts";
import { type Gate, refine, type Reviewer } from "../harness/loop";
import { loadRubric } from "../harness/rubric";
import type { Stage } from "../harness/runner";
import { agentSchema } from "../harness/schema";
import { commitRef, type Data, githubOf, issueDates, type Ref, type Reels, readJson, refOf, reposOf, shortsOf, type Stories } from "../issue";
import { meaningOf } from "../layout";
import { estimated, fitted, INSIDE, lookOf, MAX_SECONDS, MIN_SECONDS, MOTION_TAB, moveOf, refsOf, type Storyboard, speechOf, stills, timeline } from "../motion";
import { kokoro, type Speaker, voiceOf } from "../voice";
import { chosen, issueOf, slim } from "./day";

// The Explainer picks one flow across the whole system and storyboards a tour of it; check (with the narration
// spoken, for its length) and a render gate it; the Viewer grades it. An edition gets one only when the run asks.

type Answer = { make: boolean; why: string; storyboard?: Storyboard };

// Whether this edition gets a motion: a flag decides; else, in a terminal, the person running it; else project.json.
export async function wantMotion(o: { flag?: boolean; configured?: boolean; ask?: () => Promise<boolean> | boolean }) {
  if (o.flag !== undefined) return o.flag;
  if (o.ask) return o.ask();
  return o.configured ?? false;
}

// The question a terminal run asks; anything but y or yes is no.
export const askMotion = () => /^y(es)?$/i.test((prompt(`Make a ${MOTION_TAB} for this edition? [y/N]`) ?? "").trim());

// The recent motions' flows, so the Explainer takes another one.
export async function recent(root: string, date: string, n = 10): Promise<Recent[]> {
  const out: Recent[] = [];
  for (const d of (await issueDates(root)).filter((x) => x < date).slice(-n)) {
    const file = join(root, "issues", d, "motion.json");
    if (!(await Bun.file(file).exists())) continue;
    const m = await readJson<Partial<Storyboard>>(file);
    // An older storyboard, of scenes, had no stops: its title still says what it covered.
    out.push({ date: d, flow: m.flow ?? "", title: m.title ?? "", parts: (m.stops ?? []).map((s) => s.part) });
  }
  return out;
}

// The stage, with the voice it speaks with and how it reads the repos: Kokoro and GitHub, or stand-ins in tests.
export function motionStageWith(speak: Speaker, read: Reader): Stage {
  return {
    name: "motion",
    // Optional: a run restarted after it doesn't make it again.
    makes: [],
    async run(ctx) {
      const log = ctx.log("motion");
      const config = ctx.pipeline.motion;
      if (!config?.enabled) {
        log(`no ${MOTION_TAB} motion for this edition (--motion, or pipeline.motion.enabled in project.json)`);
        return;
      }
      const [data, stories] = await Promise.all([ctx.read<Data>("data.json"), ctx.read<Stories>("stories.json")]);
      const reels = (await ctx.has("reels.json")) ? await ctx.read<Reels>("reels.json") : { threads: [] };
      const issue = issueOf(ctx, data, stories, reels.threads);
      const home = reposOf(ctx.project)[0];
      const gh = githubOf(data);
      const titled = new Map<Ref, { title: string; body: string }>([
        ...gh.prs.map((p) => [refOf(p.repo, p.number, home), p] as const),
        ...(gh.commits ?? []).map((c) => [commitRef(c.repo, c.sha, home), c] as const),
      ]);
      const voice = voiceOf(config);
      const look = lookOf(ctx.project.name, ctx.date);
      const props = (sb: Storyboard) => ({ storyboard: sb, system: ctx.system, look, voice });
      // How long a storyboard runs as the voice is expected to say it.
      const expected = (sb: Storyboard) => timeline(sb, estimated(sb, voice.speed).seconds).seconds;
      const shots = await mkdtemp(join(tmpdir(), "daily-motion-stills-"));
      const before = await recent(ctx.root, ctx.date);
      // What today's reels already say, so the tour says something else.
      // The docs and code of the parts the tour is likely about; without them the tour has only the map and the brief.
      let sources: Excerpt[] = [];
      try {
        const touched = [...new Set(stories.sections.flatMap((s) => s.cards.flatMap((c) => c.parts)))];
        sources = await read({ system: ctx.system, repos: reposOf(ctx.project), topic: config.topic, touched });
      } catch (e) {
        log(`read no sources from the repos (${(e as Error).message}); the tour has the map and the brief`);
      }
      const kept = Bun.file(join(ctx.dir, "sources.json"));
      if (sources.length) {
        await ctx.write("sources.json", sources);
        log(`read ${sources.length} files: ${sources.map((s) => s.from).join(", ")}`);
      } else if (await kept.exists()) await kept.delete();
      const told = { stories: stories.sections.map((s) => s.title), reels: shortsOf(reels).map((r) => r.headline) };
      let spoken = 0;

      const gates: Gate<Answer>[] = [
        // The words against the data and the map, and its length as the voice is expected to say it. Nothing is
        // spoken in review: the Viewer sees pictures and reads the words.
        {
          name: "check",
          run: async (a) => {
            if (!a.make) return { errors: [] };
            if (!a.storyboard) return { errors: ["make is true, but there is no storyboard"] };
            spoken = expected(a.storyboard);
            return { errors: (await checkMotion(issue, a.storyboard, { recent: before, seconds: spoken, how: "as its words will be spoken" })).errors };
          },
        },
        // The engine draws it: pictures of the opening map, a few stops and the pull-back, which the Viewer gets.
        {
          name: "render",
          run: async (a) => {
            if (!a.make || !a.storyboard) return { errors: [] };
            try {
              const made = await stills(props(a.storyboard), join(shots, String(Date.now())));
              // The engine lays the map out; labels on labels mean a layout it should have refused, so say so.
              const errors = [...made.overlaps.map((o) => `the map's labels collide: ${o}; shorten the labels, or try a tour with other parts`), ...made.legibility];
              return { errors, evidence: made.pictures };
            } catch (e) {
              return { errors: [`the motion doesn't render: ${(e as Error).message.split("\n")[0]}`] };
            }
          },
        },
      ];
      const map = meaningOf(ctx.system);
      const reviewers: Reviewer<Answer>[] = [
        {
          agent: "viewer",
          rubric: await loadRubric("viewer"),
          show: (a, evidence) => {
            const sb = a.storyboard as Storyboard;
            const pictures = (evidence.render as { label: string; path: string }[] | undefined) ?? [];
            const on = new Set(sb.stops.map((s) => s.part));
            return {
              input: {
                ...(ctx.brief ? { brief: ctx.brief } : {}),
                ...(sources.length ? { sources } : {}),
                storyboard: sb,
                seconds: spoken,
                newToday: refsOf(sb).map((ref) => ({ ref, title: titled.get(ref)?.title ?? "", body: (titled.get(ref)?.body ?? "").slice(0, 1500) })),
                parts: ctx.system.parts.filter((p) => on.has(p.id)).map((p) => ({ id: p.id, name: p.name, what: p.what })),
                system: { parts: ctx.system.parts.map((p) => p.name), edges: map.edges.map((e) => `${e.from} → ${e.to}: ${e.label}`) },
                todaysReels: told,
                pictures: pictures.map((p) => p.label),
              },
              images: pictures.map((p) => p.path),
            };
          },
        },
      ];
      const github = { ...slim(data).sources.github, openPrs: gh.openPrs.map(({ body: _b, ...o }) => o), issues: undefined, week: undefined };
      const input = {
        project: { id: ctx.project.id, name: ctx.project.name },
        // The editors' choice, for this run or the project: the Explainer tours it.
        ...(config.topic ? { topic: config.topic } : {}),
        ...(ctx.brief ? { brief: ctx.brief } : {}),
        ...(sources.length ? { sources } : {}),
        date: ctx.date,
        edition: data.edition,
        system: {
          parts: ctx.system.parts.map((p) => ({ id: p.id, name: p.name, sub: p.sub, what: p.what })),
          edges: map.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
          groups: map.groups.map((g) => ({ label: g.label, kind: g.kind, members: g.members, ...(g.parent ? { parent: g.parent } : {}) })),
          inside: `"${INSIDE}" moves between two parts in the same frame`,
        },
        today: {
          headline: stories.headline,
          stories: stories.sections.map((s) => ({ title: s.title, dek: s.dek, cards: s.cards.map((c) => ({ ref: c.ref, parts: c.parts, headline: c.headline, plain: c.plain })) })),
          reels: told.reels,
        },
        data: { ...data, sources: { ...data.sources, github } },
        recent: before,
        limits: { minSeconds: MIN_SECONDS, maxSeconds: MAX_SECONDS, spoken: "about 3 words a second, 0.15 s more for each comma or dash, 0.3 s between two sentences of a stop, and about 1.5 s a stop for the camera's move" },
      };
      try {
        const r = await refine<Answer>({
          model: ctx.model, author: "explainer", input, schema: await agentSchema("explainer"),
          ...chosen(ctx, "motion", gates, reviewers),
          settled: (a) => !a.make, trace: ctx.trace("motion"), log,
        });
        ctx.runs.push(...r.runs);
        await ctx.graded("motion", r);
        const { make, why, storyboard } = r.value;
        if (storyboard) spoken = expected(storyboard);
        if (!make || !storyboard) {
          log(`the Explainer made none: ${why}`);
          ctx.meta.motion = { made: false, why };
          await rm(ctx.at("motion.json"), { force: true });
          return;
        }
        // The kept storyboard, and only it, is spoken: its real timing, its beats fitted to the length if the voice
        // ran long or short. The lines stay in the cache for render.
        const started = performance.now();
        const speech = await speechOf(props(storyboard), speak);
        const { seconds, slack } = fitted(storyboard, speech.seconds);
        const voiced = Math.round((performance.now() - started) / 100) / 10;
        // Which move each stop used, and why a free beat fit no move: patterns that recur become moves.
        const moves = storyboard.stops.map((s) => moveOf(s)?.move ?? null);
        const free = storyboard.stops.flatMap((s, i) => (moveOf(s)?.move === "free" ? [{ stop: i + 1, part: s.part, why: s.free?.why ?? "" }] : []));
        ctx.meta.motion = { made: true, title: storyboard.title, flow: storyboard.flow, why, seconds, estimated: spoken, moves, ...(free.length ? { free } : {}), ...(slack !== 1 ? { slack: Math.round(slack * 100) / 100 } : {}) };
        await ctx.write("motion.json", storyboard);
        log(`"${storyboard.title}" (${storyboard.flow}): ${storyboard.stops.length} stops, ${seconds} s spoken (estimated ${spoken} s; voiced in ${voiced} s)`);
      } finally {
        await rm(shots, { recursive: true, force: true });
      }
    },
  };
}

export const motionStage = motionStageWith(kokoro, readRepos);
