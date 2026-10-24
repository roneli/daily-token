import { expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMotion } from "../check";
import { createCtx } from "../harness/context";
import { scripted } from "../harness/model";
import { run } from "../harness/runner";
import { ENGINE, loadIssue } from "../issue";
import { estimate, estimated, fitted, linesOf, lookOf, type Storyboard, startsOf, timeline } from "../motion";
import { daily } from "../pipeline";
import type { Speaker } from "../voice";
import { motionStageWith, queued, wantMotion } from "./motion";

const DATE = "2026-01-15";
const VIEWER = ["how", "deep", "clear", "big", "engaging", "fresh", "honest", "legible"];
const grade = (n: number) => ({ scores: Object.fromEntries(VIEWER.map((i) => [i, n])), notes: [], asks: n < 5 ? [{ criterion: "big", ask: "stop 3: say why the pad waits for guidance" }] : [] });

// A voice that speaks nothing, at a known pace: each line takes a third of a second per word, as a quiet tone.
const spoken: string[][] = [];
const stub: Speaker = async (lines) => {
  spoken.push(lines);
  const rate = 8000;
  const seconds = lines.map((l) => l.split(" ").length / 3);
  return { rate, seconds, samples: seconds.map((s) => Float32Array.from({ length: Math.round(s * rate) }, (_, i) => 0.05 * Math.sin(i / 8))) };
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "motion-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const storyboard = (await Bun.file(join(root, "issues", DATE, "motion.json")).json()) as Storyboard;
  await Bun.file(join(root, "issues", DATE, "motion.json")).delete();
  return { root, storyboard };
}

const runStage = (ctx: Awaited<ReturnType<typeof createCtx>>) => run(ctx, [...daily.slice(0, 3), motionStageWith(stub, async () => []), daily[4]], { from: "motion", to: "motion" });

test("a flag decides the motion; else a terminal asks; else project.json, which defaults to no", async () => {
  const never = () => {
    throw new Error("asked");
  };
  expect(await wantMotion({ flag: false, configured: true, ask: never })).toBe(false);
  expect(await wantMotion({ flag: true, ask: never })).toBe(true);
  expect(await wantMotion({ configured: false, ask: () => true })).toBe(true);
  expect(await wantMotion({ configured: true, ask: () => false })).toBe(false);
  expect(await wantMotion({ configured: true })).toBe(true);
  expect(await wantMotion({})).toBe(false);
});

test("the motion stage storyboards a tour, sends check's errors back, speaks it for its length, and writes motion.json once the Viewer passes it", async () => {
  const { root, storyboard } = await fixture();
  const wrong: Storyboard = { ...storyboard, stops: storyboard.stops.map((s, i) => (i === 1 ? { ...s, via: "launches" } : i === 2 ? { ...s, today: [99] } : s)) };
  const model = scripted({ explainer: [{ make: true, why: "a launch crosses the whole rocket", storyboard: wrong }, { make: true, why: "a launch crosses the whole rocket", storyboard }, { make: true, why: "a launch crosses the whole rocket", storyboard }], viewer: [grade(3), grade(5)] });
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model, set: { motion: { enabled: true, gates: ["check"] } } });
  spoken.length = 0;
  const { meta } = await runStage(ctx);
  expect(model.sent.explainer[1]).toContain("joins launchpad and engine in system.json; launchpad's edges:");
  expect(model.sent.explainer[1]).toContain("marks #99 new today, but it isn't in today's data.json");
  expect(model.sent.explainer[2]).toContain("say why the pad waits for guidance");
  // The Explainer sees today's reels, so it says something else, and the map's edges with their ends.
  expect(model.sent.explainer[0]).toContain("The pad waits for the gyro before it lets go");
  expect(model.sent.explainer[0].replace(/\s+/g, "")).toContain('{"from":"launchpad","to":"engine","label":"holds"}');
  expect(await ctx.read<Storyboard>("motion.json")).toEqual(storyboard);
  // Three drafts were checked and two reviewed, but only the kept one is spoken, once.
  expect(spoken).toEqual([linesOf(storyboard)]);
  const seconds = fitted(storyboard, linesOf(storyboard).map((l) => l.split(" ").length / 3)).seconds;
  const guess = timeline(storyboard, estimated(storyboard, 1.08).seconds).seconds;
  expect(meta.reviews).toEqual({ motion: { stop: "passed", scores: [3, 5], costUsd: 0.05 } });
  expect(meta.motion).toEqual({ made: true, title: storyboard.title, flow: storyboard.flow, why: "a launch crosses the whole rocket", seconds, estimated: guess, moves: ["gate", "steps", null, null, "fanout"] });
});

test("without --motion or pipeline.motion.enabled the stage asks no agent", async () => {
  const { root } = await fixture();
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}) });
  await runStage(ctx);
  expect(await ctx.has("motion.json")).toBe(false);
});

test("an Explainer that finds no tour worth making is not reviewed, and leaves no motion.json", async () => {
  const { root, storyboard } = await fixture();
  await Bun.write(join(root, "issues", DATE, "motion.json"), JSON.stringify(storyboard));
  const model = scripted({ explainer: [{ make: false, why: "the map has four parts and yesterday toured them all" }] });
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model, set: { motion: { enabled: true } } });
  const { meta } = await runStage(ctx);
  expect(model.sent.viewer).toBeUndefined();
  expect(await ctx.has("motion.json")).toBe(false);
  expect(meta.motion).toEqual({ made: false, why: "the map has four parts and yesterday toured them all" });
});

test("the narration is held to Simplified Technical English, and at least half the stops show their steps", async () => {
  const { root, storyboard: sb } = await fixture();
  // A brief that calls the engine "motor" too, and the pad and the engine both "stage".
  await Bun.write(join(root, "brief.json"), JSON.stringify({ about: "A rocket and its ground station.", names: [{ name: "Engine", aka: ["motor", "stage"], is: "Burns fuel and pushes the rocket." }, { name: "Launch pad", aka: ["stage"], is: "Holds the rocket." }], terms: [] }));
  const issue = await loadIssue(root, DATE);
  expect((await checkMotion(issue, sb)).warnings).toEqual([]);
  const long = "The engine makes a spark and then it burns the fuel and then it pushes the rocket up into the sky above.";
  const stops = sb.stops.map((s, i) => (i === 1 ? { ...s, say: long } : i === 3 ? { ...s, say: "The engine is steered by guidance. The motor handles the rest." } : s));
  const r = await checkMotion(issue, { ...sb, stops });
  expect(r.errors).toEqual([`motion stop 2 (engine): "${long}" has 22 words; a sentence has at most 20 (one idea each)`]);
  expect(r.warnings).toEqual([
    'motion stop 4 (engine): "is steered" is passive; name the actor first ("The agent checks it", not "It is checked")',
    'motion stop 4 (engine): "handles" is vague; say the action',
    'motion calls Engine "engine" and "motor"; one word for one thing: say "Engine" each time',
  ]);
  // A word the brief defines is the project's own, not vague.
  await Bun.write(join(root, "brief.json"), JSON.stringify({ about: "A rocket and its ground station.", names: [{ name: "Engine", is: "Burns fuel and pushes the rocket." }], terms: [{ term: "handle", plain: "a stand-in name for a key" }] }));
  const termed = { ...sb, stops: sb.stops.map((s, i) => (i === 3 ? { ...s, say: "The engine reads each handle first." } : s)) };
  expect((await checkMotion(await loadIssue(root, DATE), termed)).warnings).toEqual([]);
  await Bun.write(join(root, "brief.json"), JSON.stringify({ about: "A rocket and its ground station.", names: [{ name: "Engine", aka: ["motor", "stage"], is: "Burns fuel and pushes the rocket." }, { name: "Launch pad", aka: ["stage"], is: "Holds the rocket." }], terms: [] }));
  const shared = await checkMotion(issue, { ...sb, closing: "Each stage waits for the stage before it." });
  expect(shared.warnings).toContain('motion says "stage", which the brief uses for Engine and Launch pad; name each one by its own name');
  // The how lives in the steps.
  const shallow = { ...sb, stops: sb.stops.map((s, i) => (i ? { ...s, move: undefined, beats: undefined } : s)) };
  expect((await checkMotion(issue, shallow)).errors).toContain("motion: 1 of 5 stops have a move; at least half show how their part works");
});

test("speech sets the time: each stop lasts its spoken line plus the camera's move, and review rounds are held to 40–90 s by the estimate", async () => {
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const sb = issue.motion as Storyboard;
  const slow = timeline(sb, linesOf(sb).map(() => 4));
  const fast = timeline(sb, linesOf(sb).map(() => 2));
  const stop = (t: typeof slow, i: number) => t.beats.filter((b) => b.kind === "stop")[i];
  // A stop with nothing inside to read lasts exactly its line, its move and a beat.
  expect(stop(slow, 3).end - stop(slow, 3).start - (stop(fast, 3).end - stop(fast, 3).start)).toBeCloseTo(2);
  // Each line is spoken after the one before it ends.
  for (const t of [slow, fast]) for (const [i, b] of t.beats.entries()) if (i) expect(b.speak).toBeGreaterThanOrEqual(t.beats[i - 1].speak + t.beats[i - 1].speech);
  expect((await checkMotion(issue, sb, { seconds: 35 })).errors).toEqual(["the motion runs 35 s spoken; it runs 40–90 s"]);
  expect((await checkMotion(issue, sb, { seconds: 64 })).errors).toEqual([]);
  expect((await checkMotion(issue, sb, { seconds: 95, how: "as its words will be spoken" })).errors).toEqual(["the motion runs 95 s as its words will be spoken; it runs 40–90 s"]);
  // The estimate: a breath at each comma, and 2.83 words a second at the voice's speed.
  expect(estimate("one two three four five six seven eight nine ten")).toBeCloseTo(0.1 + 10 / 2.83);
  expect(estimate("one two three four five, six seven eight nine ten", 1.25)).toBeCloseTo(0.25 + 10 / (2.83 * 1.25));
});

test("a voice that runs long or short is fitted: the moves and pauses shrink or stretch, the words don't, and what can't fit fails saying so", () => {
  const sb = { title: "t", dek: "d", flow: "f", question: "q", opening: "o", closing: "c", stops: ["a", "b", "c", "d"].map((part, i) => ({ part, say: "s", ...(i ? { via: "e" } : {}) })) };
  const at = (n: number) => sb.stops.map(() => n);
  const ok = fitted(sb, [1, 4, ...at(9), 4]);
  expect(ok.slack).toBe(1);
  const long = fitted(sb, [1, 6, ...at(17.5), 6]);
  expect(long.slack).toBeLessThan(1);
  expect(long.seconds).toBeLessThanOrEqual(90);
  expect(long.seconds).toBeGreaterThan(88);
  // Each line still gets its whole spoken length.
  for (const b of long.beats) expect(b.end - b.speak).toBeGreaterThanOrEqual(b.speech);
  const short = fitted(sb, [1, 2, ...at(4), 2]);
  expect(short.slack).toBeGreaterThan(1);
  expect(short.seconds).toBeGreaterThanOrEqual(40);
  expect(() => fitted(sb, [1, 10, ...at(20), 10])).toThrow(/even with its pauses and moves trimmed to the least; a motion runs 40–90 s, so its words need cutting/);
});

test("check holds a tour to the map and the data: parts, edges, frames, today's refs, numbers, names, and its steps and failures", async () => {
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const sb = issue.motion as Storyboard;
  expect(await checkMotion(issue, sb)).toEqual({ errors: [], warnings: [] });

  const stops = sb.stops.map((s, i) => {
    if (i === 0) return { ...s, via: "holds" };
    if (i === 1) return { ...s, via: "inside" };
    if (i === 2) return { ...s, part: "boosters", steps: [{ label: "Gyro settles", say: "The gyro settles." }, { label: "Holds", fail: "Quaternion filter", say: "The clamps hold." }, { label: "Clamps open", say: "The clamps open." }] };
    if (i === 3) return { ...s, say: "It steers the engine 45 times a second with `steerLoop()`." };
    return s;
  });
  const { errors } = await checkMotion(issue, { ...sb, stops, dek: `${sb.dek} See #12345.` });
  expect(errors).toEqual([
    "motion stop 1 (launchpad): the first stop is where the tour starts; it has no via",
    'motion stop 2 (engine): "inside" moves within one frame of the map, and launchpad and engine aren\'t in the same one',
    'motion stop 3 (boosters): "boosters" isn\'t a part in system.json',
    "motion dek mentions #12345, which data.json doesn't know",
    'motion stop 3 (boosters) shows "Quaternion filter" as beat 2\'s failure, but "quaternion", "filter" is in none of the brief, the system map or the data',
    "motion stop 4 (engine) says 45, which is in none of the data, the digest, the system map or the brief",
    "motion stop 4 (engine) names `steerLoop()`, which is in none of the data, the digest, the system map or the brief",
  ]);

  // A walk through today's changes, or a story's title again, is the reels, not a tour.
  const news: Storyboard = { ...sb, title: "The pad waits for the gyro before it lets go", stops: sb.stops.map((s, i) => (i < 3 ? { ...s, today: ["ground#11"] } : s)) };
  expect((await checkMotion(issue, news)).errors).toEqual([
    "motion: 3 of 5 stops are today's changes; that walks through the news like the reels. Show how the area works and where it sits, and mark today's changes on the way",
    'motion title "The pad waits for the gyro before it lets go" retells today\'s "The pad waits for the gyro before it lets go"; the reels tell the news, the motion how the system works',
  ]);
  // A tour that stays put isn't one; a flow just shown is a warning.
  const still: Storyboard = { ...sb, stops: [sb.stops[0], sb.stops[1], { ...sb.stops[3], via: "holds", part: "launchpad" }, sb.stops[1]] };
  expect((await checkMotion(issue, still)).errors).toContain("motion: the tour crosses 2 parts; it shows how the system fits together, so it crosses at least 3");
  const again = await checkMotion(issue, sb, { recent: [{ date: "2026-01-14", flow: "A launch, end to end", title: "How a rocket gets off the pad", parts: sb.stops.map((s) => s.part) }] });
  expect(again.warnings).toEqual(['motion repeats 2026-01-14\'s tour "How a rocket gets off the pad" (A launch, end to end); take another flow']);
});

// Every motion animation follows three rules: keyframes in order, one track per element and property at a time, and
// a frame that depends only on its time. The first two are checked on the tracks; the last in a browser.
test("the tour's tracks are ordered, and no element is driven by two at once", async () => {
  const { tour } = await import("../../templates/motion/tour.layout");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const sb = issue.motion as Storyboard;
  const { tracks } = await tour({ storyboard: sb, system: issue.system, look: lookOf("Rocket", DATE), timeline: timeline(sb, estimated(sb).seconds) });
  trackRules(tracks);
});

type AnyTrack = { el: string; p: string; k?: number[][]; from?: number; to?: number };
function trackRules(tracks: AnyTrack[]) {
  const spans = new Map<string, [number, number][]>();
  for (const tr of tracks) {
    // A pulse beats whole periods and rests; one that never ends is only for the map's badges.
    if (tr.p === "pulse") {
      if (!tr.el.startsWith("badge-")) expect([tr.el, tr.to !== undefined]).toEqual([tr.el, true]);
      continue;
    }
    const times = (tr.k ?? []).map((k) => k[0]);
    expect([tr.el, times]).toEqual([tr.el, [...times].sort((a, b) => a - b)]);
    const key = `${tr.el} ${tr.p}`;
    spans.set(key, [...(spans.get(key) ?? []), [times[0], times[times.length - 1]]]);
  }
  for (const [key, list] of spans) {
    // Only a path-follower has several tracks, one per path, one after another.
    if (!key.endsWith(" along")) expect([key, list.length]).toEqual([key, 1]);
    const sorted = [...list].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBeGreaterThanOrEqual(sorted[i - 1][1]);
  }
}

test("a frame depends only on its time: the token settles at a flow's last step and stays still, whatever was drawn before", async () => {
  const { tour } = await import("../../templates/motion/tour.layout");
  const { page } = await import("../motion");
  const { browser } = await import("../browser");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const sb = issue.motion as Storyboard;
  const tl = timeline(sb, estimated(sb).seconds);
  const props = { storyboard: sb, system: issue.system, look: lookOf("Rocket", DATE), voice: { voiceover: false, voice: "af_heart", speed: 1 } };
  const laid = await tour({ ...props, timeline: tl });
  const { tracks } = laid;
  const b = await browser();
  try {
    const p = await b.newPage({ viewport: { width: 540, height: 675 } });
    await p.setContent(await page(laid));
    // Each flow's token: where it is in the frames around and after its last step, seeked in order and out of order.
    // Every token a move runs: in this fixture, the steps' tokens.
    const tokens = tracks.filter((t) => t.p === "along" && t.el.startsWith("mv"));
    expect(tokens.length).toBeGreaterThan(0);
    for (const tok of tokens) {
      if (tok.p !== "along") continue;
      const end = tok.k[tok.k.length - 1][0];
      const frames = [0, 1, 2, 3, 4, 5, 6].map((n) => end + (n * 1000) / 30);
      const at = (t: number) => p.evaluate(([id, time]) => {
        (window as unknown as { seek: (t: number) => void }).seek(time as number);
        return document.getElementById(id as string)?.getAttribute("transform");
      }, [tok.el, t] as const);
      const forward: (string | null | undefined)[] = [];
      for (const t of frames) forward.push(await at(t));
      expect(new Set(forward).size).toBe(1);
      // Out of order, as four pages filming every fourth frame do: the same picture.
      for (const t of [...frames].reverse()) expect(await at(t)).toBe(forward[0]);
      await at(0);
      expect(await at(frames[3])).toBe(forward[0]);
    }
    // And the whole frame: seeking to a moment from before or after it gives the same page.
    const snapshot = (t: number) => p.evaluate((time) => {
      (window as unknown as { seek: (t: number) => void }).seek(time);
      return [...document.querySelectorAll("[id]")].map((e) => `${e.id} ${e.getAttribute("transform") ?? ""} ${(e as HTMLElement).style.cssText}`).join("\n");
    }, t);
    const mid = tl.beats[2].speak * 1000 + 700;
    await snapshot(0);
    const fromStart = await snapshot(mid);
    await snapshot(tl.seconds * 1000);
    expect(await snapshot(mid)).toBe(fromStart);
  } finally {
    await b.close();
  }
}, 180_000);

test("the map's edge labels are kept clear of each other, of the parts and of other edges' lines", async () => {
  const { clashes, snake } = await import("../../templates/motion/tour.layout");
  const parts = ["a", "b", "c", "d", "e"].map((id) => ({ id, name: id.toUpperCase(), sub: "", what: "" }));
  // A loop down one column and back: the edges that skip a row round the outside, each label beside its own line.
  const edges = [
    { from: "a", to: "b", label: "first" },
    { from: "b", to: "c", label: "second" },
    { from: "c", to: "d", label: "third" },
    { from: "d", to: "e", label: "fourth" },
    { from: "e", to: "a", label: "back to the start" },
    { from: "b", to: "e", label: "a shortcut across" },
  ];
  expect(clashes(snake(parts, edges, ["a", "b", "c", "d", "e"]))).toEqual([]);
  // Two labels in one place are caught.
  const map = snake(parts, edges, ["a", "b", "c", "d", "e"]);
  const stacked = { ...map, edges: map.edges.map((e, i) => (i === 1 ? { ...e, at: map.edges[0].at, anchor: map.edges[0].anchor } : e)) };
  expect(clashes(stacked)).toContain('"first" overlaps "second"');
});

// Needs a headless Chrome and ffmpeg: a second of the tour, small, with the stand-in voice.
test("the fixture tour renders: pictures for the Viewer, an H.264 MP4 with its voice, a poster and its timing", async () => {
  const { renderMotion, stills } = await import("../motion");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const props = { storyboard: issue.motion as Storyboard, system: issue.system, look: lookOf("Rocket", DATE), voice: { voiceover: true, voice: "af_heart", speed: 1 } };
  const dir = await mkdtemp(join(tmpdir(), "motion-render-"));
  const pictures = await stills(props, join(dir, "stills"), 0.25);
  expect(pictures.overlaps).toEqual([]);
  expect(pictures.pictures.map((p) => p.label)).toEqual(["the opening map", "stop 1 (launchpad), its gate played", "stop 2 (engine), its steps played", "stop 5 (ci), its fanout played", "the closing pull-back"]);
  const made = await renderMotion(props, dir, stub, { scale: 0.25, frames: [0, 29], workers: 2 });
  expect(made.frames).toBe(30);
  expect(made.video).toMatch(/^motion\.[0-9a-f]{10}\.mp4$/);
  expect(made.starts).toEqual(startsOf(fitted(props.storyboard, linesOf(props.storyboard).map((l) => l.split(" ").length / 3))));
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "compact=p=0:nk=1", join(dir, made.video)]).stdout.toString().trim().split("\n");
  expect(probe.map((l) => l.split("|").filter(Boolean).join(","))).toEqual(["h264,270,338", "aac"]);
  expect(await Bun.file(join(dir, made.poster)).exists()).toBe(true);
  expect(await Bun.file(join(dir, made.timing)).json()).toEqual({ seconds: made.seconds, starts: made.starts });
}, 120_000);

test("an issue with a motion gets the Cutaway tab, with its video and its spoken lines to read at their times; one without has no tab", async () => {
  const { renderIssue } = await import("../render");
  const root = join(ENGINE, "fixtures", "sample");
  // A line for every sentence: the title, the opening, each stop's first sentence and its steps', the closing.
  const files = { video: "motion.0123456789.mp4", poster: "motion.0123456789.jpg", seconds: 61.5, starts: Array.from({ length: 17 }, (_, i) => 0.8 + i * 3.7) };
  const { html } = await renderIssue(await loadIssue(root, DATE), { css: "", js: "" }, files);
  expect(html).toContain('<button role="tab" id="tab-motion" type="button" aria-selected="false">Cutaway</button>');
  expect(html).toContain('<source src="motion.0123456789.mp4" type="video/mp4">');
  expect(html).toContain('data-seek="0.8" aria-label="Play from 0:00">0:00</button><span>How a rocket gets off the pad in one go.</span>');
  expect(html).toContain('data-seek="8.2" aria-label="Play from 0:08">0:08</button><span>The launch pad decides when the rocket can leave.');
  expect(html).toContain('data-seek="11.9" aria-label="Play from 0:11">0:11</button><span>First, the countdown runs to zero.');
  expect(html).toContain("Launch pad → Engine → Guidance → CI");
  expect(html).toContain("Cutaway · A launch, end to end · 1:01");
  expect(html).toContain("<span>A launch has one chance, and any part can stop it.");
  expect((await renderIssue(await loadIssue(root, "2026-01-14"), { css: "", js: "" })).html).not.toContain("tab-motion");
});

// Every move, and a free beat, on the fixture's map: each laid out, timed and drawn by the engine.
const MOVES_TOUR: Storyboard = {
  title: "Every move the engine draws",
  dek: "One stop for each move.",
  flow: "A launch, every way",
  question: "How does each part show its insides?",
  opening: "Each part opens a different way. Watch each one.",
  stops: [
    { part: "launchpad", say: "The pad holds the rocket.", move: "gate", check: "Guidance steady?", beats: [{ label: "Countdown runs", say: "First, the countdown runs out." }, { label: "Gyro not settled", tone: "bad", say: "If the gyro moves, the clamps stay shut." }, { label: "Clamps open", tone: "good", say: "Once it is steady, they open." }] },
    { part: "engine", via: "holds", say: "Next, the engine lights.", move: "steps", beats: [{ label: "Spark", fail: "Tries again", say: "It makes a spark, and tries again on a miss." }, { label: "Burns fuel", say: "Then it burns the fuel." }, { label: "Pushes the rocket", tone: "good", say: "So the thrust pushes the rocket up." }] },
    { part: "guidance", via: "steers", say: "Guidance keeps the rocket straight.", move: "layers", beats: [{ label: "Autopilot", ring: 1, say: "The autopilot sets the course." }, { label: "Gyro", ring: 2, say: "Inside it, the gyro feels every turn." }, { label: "Steady signal", ring: 3, tone: "good", say: "Only a steady signal lets the pad go." }] },
    { part: "engine", via: "steers", say: "A missed spark used to stop a launch.", move: "compare", sides: ["Before", "Now"], beats: [{ label: "Spark misses", other: "Spark misses", say: "In both, the first spark misses." }, { label: "Launch stops", other: "Tries again", say: "Before, the launch stopped; now it tries again." }] },
    { part: "ci", via: "tests", say: "CI tests every change.", move: "fanout", source: "A new change", beats: [{ label: "Engine tests", count: 3, say: "First, it runs the engine tests." }, { label: "Every test", count: 6, tone: "good", say: "Then every other test runs." }] },
    { part: "engine", via: "tests", say: "The engine checks itself in a loop.", move: "cycle", laps: 1, beats: [{ label: "Reads the gauges", say: "It reads the gauges." }, { label: "Compares", say: "Then it compares them." }, { label: "Adjusts the thrust", say: "And it adjusts the thrust." }] },
    {
      part: "launchpad",
      via: "holds",
      say: "The pad and the rocket, last of all.",
      move: "free",
      beats: [{ say: "The pad holds the rocket." }, { say: "Then the rocket leaves." }],
      free: {
        why: "A hand-over between two things fits no move.",
        nodes: [{ id: "pad", label: "Launch pad", at: [0, 1] }, { id: "rocket", label: "Rocket", shape: "dot", at: [2, 1], beat: 1 }],
        links: [{ id: "hold", from: "pad", to: "rocket", label: "holds" }],
        copies: [{ id: "clamp", of: "pad", n: 4, arrange: "row" }],
        tokens: [{ along: "hold", beat: 1 }],
        texts: [{ id: "count", text: "Countdown", at: [1, 0] }],
        effects: [{ effect: "zoom", target: "pad", beat: 0 }, { effect: "draw", target: "hold", beat: 0 }, { effect: "pulse", target: "rocket", beat: 1 }, { effect: "orbit", target: "rocket", beat: 1 }],
      },
    },
  ],
  closing: "Seven parts, seven ways in. That is every move.",
};

test("every move lays out with ordered, single tracks, words a phone can read, and nothing on top of anything", async () => {
  const { tour } = await import("../../templates/motion/tour.layout");
  const { stills } = await import("../motion");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const tl = timeline(MOVES_TOUR, estimated(MOVES_TOUR).seconds);
  const laid = await tour({ storyboard: MOVES_TOUR, system: issue.system, look: lookOf("Rocket", DATE), timeline: tl });
  expect(laid.moves.map((m) => m.move)).toEqual(["gate", "steps", "layers", "compare", "fanout", "cycle", "free"]);
  expect(laid.legibility).toEqual([]);
  trackRules(laid.tracks);
  const props = { storyboard: MOVES_TOUR, system: issue.system, look: lookOf("Rocket", DATE), voice: { voiceover: false, voice: "af_heart", speed: 1 } };
  const made = await stills(props, await mkdtemp(join(tmpdir(), "motion-moves-")), 0.25);
  expect(made.overlaps).toEqual([]);
  expect(made.legibility).toEqual([]);
}, 180_000);

test("every move comes to rest: its card's last frames are the same picture", async () => {
  const { laidOut, page } = await import("../motion");
  const { browser } = await import("../browser");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const tl = timeline(MOVES_TOUR, estimated(MOVES_TOUR).seconds);
  const props = { storyboard: MOVES_TOUR, system: issue.system, look: lookOf("Rocket", DATE), voice: { voiceover: false, voice: "af_heart", speed: 1 } };
  const b = await browser();
  try {
    const p = await b.newPage({ viewport: { width: 540, height: 675 } });
    await p.setContent(await page(await laidOut(props, tl)));
    const card = (i: number, t: number) => p.evaluate(([n, time]) => {
      (window as unknown as { seek: (t: number) => void }).seek(time);
      return [...(document.getElementById(`card-${n}`)?.querySelectorAll("[id]") ?? [])].map((e) => `${e.id} ${e.getAttribute("transform") ?? ""} ${(e as HTMLElement).style.cssText}`).join("\n");
    }, [i, t] as const);
    for (const beat of tl.beats.filter((x) => x.kind === "stop")) {
      const end = beat.end * 1000 - 400;
      const last = await card(beat.index, end);
      // A frame apart, two apart, and out of order: the same.
      for (const t of [end - 66, end - 33, end - 400]) expect([MOVES_TOUR.stops[beat.index].move, await card(beat.index, t)]).toEqual([MOVES_TOUR.stops[beat.index].move, last]);
    }
  } finally {
    await b.close();
  }
}, 180_000);

test("check holds each move to what it needs, and a free beat to its own parts and size", async () => {
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const base = issue.motion as Storyboard;
  const at = (k: number, stop: Partial<Storyboard["stops"][number]>) => ({ ...base, stops: base.stops.map((s, i) => (i === k ? { ...s, ...stop } : s)) });
  const errorsOf = async (sb: Storyboard) => (await checkMotion(issue, sb)).errors;
  expect(await errorsOf(at(0, { check: undefined, beats: [{ label: "Countdown runs", say: "It runs." }, { label: "Clamps open", tone: "good", say: "They open." }] }))).toEqual([
    "motion stop 1 (launchpad) has a gate without its check",
    "motion stop 1 (launchpad) has a gate that doesn't show both ways: a beat refused (bad) and a beat let through (good)",
  ]);
  expect(await errorsOf(at(4, { source: undefined, beats: [{ label: "Engine tests", say: "First, it runs the engine tests." }, { label: "Every test", count: 8, say: "Then the rest." }] }))).toEqual([
    "motion stop 5 (ci) has a fanout beat without its count",
    "motion stop 5 (ci) has a fanout without its source: who sends",
  ]);
  const free = MOVES_TOUR.stops[6].free as NonNullable<Storyboard["stops"][number]["free"]>;
  const broken = { ...free, links: [{ id: "hold", from: "pad", to: "moon" }], tokens: [{ along: "nowhere", beat: 3 }], texts: [{ id: "count", text: "Countdown", at: [0, 1] as [number, number] }], copies: [{ id: "clamp", of: "pad", n: 12, arrange: "grid" as const }, { id: "more", of: "pad", n: 12, arrange: "grid" as const }, { id: "most", of: "pad", n: 12, arrange: "grid" as const }] };
  expect(await errorsOf(at(2, { move: "free", beats: [{ say: "The gyro settles." }, { say: "Then the pad lets go." }], free: broken }))).toEqual([
    'motion stop 3 (guidance) links to "moon", which is no node of its free composition',
    'motion stop 3 (guidance) runs a token along "nowhere", which is no link',
    "motion stop 3 (guidance) puts two things in slot [0,1]; one slot holds one",
    "motion stop 3 (guidance) brings something in on beat 3, but it has 2 sentences",
    "motion stop 3 (guidance) composes 45 elements; a free beat has at most 40",
  ]);
});

test("narration written for the ear: the same opening or part name three sentences running is a warning", async () => {
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const sb = issue.motion as Storyboard;
  const robotic = { ...sb, stops: sb.stops.map((s, i) => (i === 1 ? { ...s, say: "The engine lights next.", beats: [{ label: "Spark", say: "The engine makes a spark." }, { label: "Burns fuel", say: "The engine burns the fuel." }, { label: "Pushes the rocket", tone: "good" as const, say: "The engine pushes the rocket up." }] } : s)) };
  expect((await checkMotion(issue, robotic)).warnings).toEqual([
    'motion stop 2 (engine): three sentences in a row start with "engine"; name the actor once, then say "it", or start with first, then, if, once',
    'motion stop 2 (engine): "engine" is named in three sentences in a row; after the first, say "it"',
  ]);
});

test("a render whose ffmpeg fails says why, and leaves nothing beside the page", async () => {
  const { renderMotion } = await import("../motion");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const props = { storyboard: issue.motion as Storyboard, system: issue.system, look: lookOf("Rocket", DATE), voice: { voiceover: true, voice: "af_heart", speed: 1 } };
  const dir = await mkdtemp(join(tmpdir(), "motion-fail-"));
  // An ffmpeg with an H.264 encoder that refuses to encode, before it reads a frame.
  const fake = join(dir, "ffmpeg");
  await Bun.write(fake, `#!/bin/sh\ncase "$*" in *-encoders*) echo " V....D libopenh264";; *) echo "Unknown encoder 'nope'" >&2; exit 1;; esac\n`);
  await chmod(fake, 0o755);
  const was = process.env.FFMPEG;
  process.env.FFMPEG = fake;
  try {
    const out = join(dir, "out");
    await expect(renderMotion(props, out, stub, { scale: 0.25, frames: [0, 9], workers: 2 })).rejects.toThrow("ffmpeg failed (exit 1): Unknown encoder 'nope'");
    expect(await readdir(out).catch(() => [])).toEqual([]);
  } finally {
    if (was === undefined) delete process.env.FFMPEG;
    else process.env.FFMPEG = was;
  }
}, 60_000);

test("render reuses a motion's files by their hash, drops any other motion's, and an issue without one keeps none", async () => {
  const { filesOf, motionFiles, motionHash } = await import("../motion");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const props = { storyboard: issue.motion as Storyboard, system: issue.system, look: lookOf("Rocket", DATE), voice: { voiceover: false, voice: "af_heart", speed: 1 } };
  const dir = await mkdtemp(join(tmpdir(), "motion-files-"));
  const names = filesOf(await motionHash(props));
  for (const f of [names.video, names.poster, "motion.0123456789.mp4", "motion.0123456789.jpg", "index.html"]) await Bun.write(join(dir, f), "x");
  await Bun.write(join(dir, names.timing), JSON.stringify({ seconds: 61.5, starts: [0.8] }));
  const never: Speaker = async () => {
    throw new Error("rendered again");
  };
  expect(await motionFiles(props, dir, never)).toEqual({ video: names.video, poster: names.poster, seconds: 61.5, starts: [0.8] });
  expect((await readdir(dir)).sort()).toEqual(["index.html", ...Object.values(names)].sort());
  expect(await motionFiles(undefined, dir, never)).toBeUndefined();
  expect(await readdir(dir)).toEqual(["index.html"]);
});

test("a motion's hash follows what its map draws, and nothing else of the map", async () => {
  const { motionHash } = await import("../motion");
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const props = { storyboard: issue.motion as Storyboard, system: issue.system, look: lookOf("Rocket", DATE), voice: { voiceover: false, voice: "af_heart", speed: 1 } };
  const hash = await motionHash(props);
  const dashed = { ...issue.system, edges: issue.system.edges.map((e, i) => (i ? e : { ...e, dashed: !e.dashed })) };
  expect(await motionHash({ ...props, system: dashed })).not.toBe(hash);
  const reworded = { ...issue.system, parts: issue.system.parts.map((p) => ({ ...p, what: `${p.what} More.` })) };
  expect(await motionHash({ ...props, system: reworded })).toBe(hash);
});

test("layers are drawn from the outside in by their rings, whatever order they are said in, and a gate shows both ways out from the start", async () => {
  const { build } = await import("../../templates/motion/moves");
  const clock = { at: (k: number) => 10_000 + k * 3000, len: () => 2500, open: 9000, end: 20_000 };
  const said = [
    { label: "Steady signal", ring: 3, say: "In the middle, a steady signal lets the pad go." },
    { label: "Gyro", ring: 2, say: "Around it, the gyro feels every turn." },
    { label: "Autopilot", ring: 1, say: "Outside it all, the autopilot sets the course." },
  ];
  const layers = build("t", { part: "guidance", say: "Guidance keeps the rocket straight." }, "layers", said, clock);
  const text = (id: string) => {
    const find = (shapes: typeof layers.shapes): string | undefined => {
      for (const s of shapes) {
        if (s.kind === "text" && s.id === id) return s.text;
        if (s.kind === "g") {
          const t = find(s.children);
          if (t) return t;
        }
      }
    };
    return find(layers.shapes);
  };
  expect([text("t-rl0"), text("t-rl1"), text("t-rl2")]).toEqual(["Autopilot", "Gyro", "Steady signal"]);
  expect(layers.clips).toEqual([]);
  // The camera goes to each ring as it is said: the innermost first, here.
  expect(layers.zoom?.map((z) => z.at)).toEqual([10_000, 13_000, 16_000]);
  expect(layers.zoom?.[0].box.w).toBeLessThan(layers.zoom?.[2].box.w ?? 0);

  const gate = build("g", { part: "launchpad", say: "The pad holds the rocket.", check: "Guidance steady?" }, "gate", [
    { label: "Countdown runs", say: "First, the countdown runs out." },
    { label: "Gyro not settled", tone: "bad", say: "If the gyro moves, the clamps stay shut." },
    { label: "Clamps open", tone: "good", say: "Once it is steady, they open." },
  ], clock);
  const faint = (el: string) => (gate.tracks.find((t) => t.el === el && t.p === "o") as { k: [number, number][] }).k;
  // Both ways out are faint once the card opens, before either is said, and full once said.
  for (const el of ["g-bad0", "g-good0"]) {
    expect(faint(el)[1]).toEqual([9300, 0.35]);
    expect(faint(el).at(-1)?.[1]).toBe(1);
  }
});

test("check numbers a layers move's rings and warns on a stop that only says where something sits", async () => {
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), DATE);
  const sb = issue.motion as Storyboard;
  const at = (k: number, stop: Partial<Storyboard["stops"][number]>) => ({ ...sb, stops: sb.stops.map((s, i) => (i === k ? { ...s, ...stop } : s)) });
  const layered = (rings: (number | undefined)[]) => at(2, { move: "layers", beats: rings.map((ring, k) => ({ label: ["Autopilot", "Gyro", "Clamps"][k], ring, say: "The pad waits." })) });
  expect((await checkMotion(issue, layered([1, 2, 3]))).errors).toEqual([]);
  expect((await checkMotion(issue, layered([1, undefined, 3]))).errors).toEqual(["motion stop 3 (guidance) has a layers beat without its ring: 1 is the outermost"]);
  expect((await checkMotion(issue, layered([1, 1, 3]))).errors).toEqual(["motion stop 3 (guidance) numbers its rings 1, 1, 3; they are 1 to 3, 1 the outermost, each once"]);
  const stored = at(2, { say: "Guidance contains the gyro." });
  expect((await checkMotion(issue, stored)).warnings).toContain('motion stop 3 (guidance) only says where something sits; fold it into the stop before or after it as one beat ("…downloads it from the guidance")');
});

test("the topic queue gives the first topic no other issue's Cutaway toured, and its own day's again", async () => {
  const root = await mkdtemp(join(tmpdir(), "queue-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const topics = ["How the clamps let go", "How the gyro steadies the climb"];
  expect(await queued(root, "2026-01-16", topics)).toBe(topics[0]);
  await Bun.write(join(root, "issues", "2026-01-14", "meta.json"), JSON.stringify({ motion: { made: true, topic: topics[0] } }));
  expect(await queued(root, "2026-01-16", topics)).toBe(topics[1]);
  // Making the 14th's Cutaway again tours its own topic again.
  expect(await queued(root, "2026-01-14", topics)).toBe(topics[0]);
  expect(await queued(root, "2026-01-16", [topics[0]])).toBeUndefined();
  expect(await queued(root, "2026-01-16", undefined)).toBeUndefined();
});
