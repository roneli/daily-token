import { createHash } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Liquid } from "liquidjs";
import type { Page } from "playwright-core";
import { spawnIn } from "./harness/model";
import { ENGINE, type Ref, type System } from "./issue";
import { meaningOf } from "./layout";
import { cacheDir, type Speaker, type Speech, type Voice, versionOf, voiceTrack, voiceVersion } from "./voice";

// The Cutaway: a tour of the whole system along one flow, on one living map. motion.json (the storyboard) is
// the Explainer's words; the engine lays the map out, times every beat by the spoken narration, draws it as a page
// (templates/motion/) that seeks to any millisecond, and films it in headless Chrome into ffmpeg.

// The tab's name, here and only here: the page, the player and the video's masthead all take it from this.
export const MOTION_TAB = "Cutaway";

// A stop on the tour: a part of system.json, reached from the stop before along one of its edges (by the edge's
// label) or "inside" one frame of the map; what is said there; how it happens inside the part, as one of the engine's
// moves; and the PRs or commits that make it new today.
//
// A move is drawn by the engine inside the opened part, one beat per spoken sentence:
// - steps: a sequence down a spine, a failure branching off a step;
// - fanout: one sender (`source`) to many, each beat reaching `count` more receivers;
// - cycle: a loop that repeats, its beats around it, `laps` times;
// - layers: nested rings, each beat's `ring` (1 the outermost), drawn outside in, the camera going to each as said;
// - compare: the same moment two ways (`sides`), a row a beat, `label` on the first side and `other` on the second;
// - gate: a request meets a `check`; a neutral beat brings it, a bad beat refuses it (its label the reason), a good
//   beat lets it through;
// - free: when none fits, a composition of the engine's primitives (`free`), laid out on a grid of slots.
export type Move = "steps" | "fanout" | "cycle" | "layers" | "compare" | "gate" | "free";
export type Tone = "good" | "bad" | "neutral";
// A beat's `say` is the sentence spoken while it plays; a storyboard from before beats were spoken has none.
export type MoveBeat = { say?: string; label?: string; tone?: Tone; fail?: string; other?: string; count?: number; ring?: number };
export type Step = MoveBeat & { label: string };
export type Slot = [col: number, row: number];
export type Free = {
  why: string;
  nodes: { id: string; label?: string; shape?: "box" | "dot"; at: Slot; beat?: number; tone?: Tone }[];
  links?: { id: string; from: string; to: string; label?: string; beat?: number; dashed?: boolean }[];
  copies?: { id: string; of: string; n: number; arrange: "row" | "ring" | "grid"; beat?: number }[];
  tokens?: { along: string; beat: number; back?: boolean }[];
  texts?: { id: string; text: string; at: Slot; beat?: number }[];
  effects?: { effect: "pulse" | "fade" | "draw" | "zoom" | "orbit"; target: string; beat: number }[];
};
export type Stop = {
  part: string;
  via?: string;
  say: string;
  move?: Move;
  beats?: MoveBeat[];
  // Before moves, a stop's sequence was its steps; they are read as the steps move.
  steps?: Step[];
  source?: string;
  sides?: [string, string];
  check?: string;
  laps?: number;
  free?: Free;
  today?: Ref[];
};
// A stop's move and its beats, whichever way the storyboard gave them.
export function moveOf(s: Stop): { move: Move; beats: MoveBeat[] } | null {
  const beats = s.beats ?? s.steps ?? [];
  const move = s.move ?? (beats.length ? "steps" : undefined);
  return move && beats.length ? { move, beats } : null;
}
export type Storyboard = {
  title: string;
  // Why it matters, in a sentence: the dek under the video.
  dek: string;
  // The flow the tour follows, as a name ("A request's journey").
  flow: string;
  // The question it answers, with its stakes; the closing line answers it.
  question: string;
  opening: string;
  stops: Stop[];
  closing: string;
};

export const INSIDE = "inside";

// Portrait 4:5: a phone shows it whole under the tabs, with room for its controls; a desk shows it beside the words.
const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1350;
// The whole motion, in seconds, once its narration is spoken.
export const MIN_SECONDS = 40;
export const MAX_SECONDS = 90;

// What is spoken in each beat, sentence by sentence: the title, then the opening; each stop's line, then its steps' sentences, each
// spoken as its step lights; the closing. Each is a clip of its own, so the steps light exactly as they are said.
export const spoken = (s: Stop) => {
  const m = moveOf(s);
  return m?.beats.every((x) => x.say) ? m.beats.map((x) => x.say as string) : [];
};
// The title is read as a sentence, so the voice ends it like one.
const titled = (title: string) => (/[.?!]$/.test(title) ? title : `${title}.`);
export const groupsOf = (sb: Storyboard) => [[titled(sb.title), sb.opening], ...sb.stops.map((s) => [s.say, ...spoken(s)]), [sb.closing]];
export const linesOf = (sb: Storyboard) => groupsOf(sb).flat();
// Each line's pace against the voice's speed: the title is read a little slower, like a heading.
const TITLE_PACE = 0.85;
export const pacesOf = (sb: Storyboard) => linesOf(sb).map((_, i) => (i === 0 ? TITLE_PACE : 1));
export const refsOf = (sb: Storyboard) => [...new Set(sb.stops.flatMap((s) => s.today ?? []))];

// A sentence's spoken length, estimated from its words: Kokoro's af_heart with the silence around a clip trimmed,
// fitted on 39 lines it spoke at 1.08 (about 2.8 words a second at speed 1, and a breath at each comma or dash).
// Review rounds are timed by this; only the kept storyboard is spoken.
export const estimate = (text: string, speed = 1) =>
  0.1 + 0.15 * (text.match(/[,;:—]/g) ?? []).length + text.split(/\s+/).filter(Boolean).length / (2.83 * speed);

// A beat of the motion, in seconds: when it starts, when each of its sentences is spoken and for how long (`segs`),
// the span from the first to the end of the last (`speak`, `speech`), and when it ends.
export type Seg = { speak: number; speech: number };
export type Beat = { kind: "open" | "stop" | "close"; index: number; start: number; travel: number; speak: number; speech: number; segs: Seg[]; end: number };
export type Timeline = { beats: Beat[]; seconds: number };

// The title and the map take their time, a stop's move takes its own, and each line gets a beat after it.
const OPEN_MIN = 6.5;
const TRAVEL_FIRST = 1.1;
const TRAVEL = 1.5;
const BEAT = 0.6;
const PULLBACK = 1.6;
const HOLD = 2.4;
// The breath between two sentences of one beat.
const GAP = 0.3;
// How far the beats around the words may shrink or stretch to bring a spoken motion into its length.
const SLACK: [min: number, max: number] = [0.55, 3];

// Every beat from the lines' lengths. `slack` scales everything but the words: the moves, the pauses, the reading.
export function timeline(sb: Storyboard, seconds: number[], slack = 1): Timeline {
  const beats: Beat[] = [];
  const groups = groupsOf(sb);
  let line = 0;
  // A beat's sentences one after another from `from`, a breath between them.
  const said = (n: number, from: number) => {
    const segs: Seg[] = [];
    let t = from;
    for (let k = 0; k < n; k++) {
      segs.push({ speak: t, speech: seconds[line] });
      t += seconds[line++] + GAP * slack;
    }
    return { segs, speak: from, speech: t - GAP * slack - from };
  };
  const speak0 = 0.8 * Math.min(1, slack);
  const first = said(groups[0].length, speak0);
  beats.push({ kind: "open", index: 0, start: 0, travel: 0, ...first, end: Math.max(OPEN_MIN * Math.min(1, slack), speak0 + first.speech + BEAT * slack) });
  let at = beats[0].end;
  for (const [i, s] of sb.stops.entries()) {
    const travel = (i === 0 ? TRAVEL_FIRST : TRAVEL) * slack;
    const voice = said(groups[i + 1].length, at + travel - 0.3 * Math.min(1, slack));
    // Steps without sentences of their own play over the line, slowly enough to follow.
    const legacy = spoken(s).length ? [] : (moveOf(s)?.beats ?? []);
    const flow = legacy.length + legacy.filter((x) => x.fail).length;
    const reading = flow ? at + travel + (0.8 + flow * 0.9 + 1.4) * Math.min(1, slack) : 0;
    const end = Math.max(voice.speak + voice.speech + BEAT * slack, reading);
    beats.push({ kind: "stop", index: i, start: at, travel, ...voice, end });
    at = end;
  }
  const last = said(1, at + 0.8 * slack);
  beats.push({ kind: "close", index: 0, start: at, travel: PULLBACK * Math.min(1, slack), ...last, end: last.speak + last.speech + HOLD * slack });
  const total = beats[beats.length - 1].end;
  return { beats, seconds: Math.round(total * 10) / 10 };
}

// When each line of linesOf is spoken.
export const startsOf = (tl: Timeline) => tl.beats.flatMap((b) => b.segs.map((x) => x.speak));

export const lengthErrors = (seconds: number, how = "spoken") =>
  seconds < MIN_SECONDS || seconds > MAX_SECONDS ? [`the motion runs ${seconds} s ${how}; it runs ${MIN_SECONDS}–${MAX_SECONDS} s`] : [];

// The timeline of a spoken motion, its beats trimmed or stretched when the voice ran long or short; an error when
// even that can't bring it into its length.
export function fitted(sb: Storyboard, seconds: number[]): Timeline & { slack: number } {
  const at = (slack: number) => ({ ...timeline(sb, seconds, slack), slack });
  const plain = at(1);
  if (plain.seconds >= MIN_SECONDS && plain.seconds <= MAX_SECONDS) return plain;
  const long = plain.seconds > MAX_SECONDS;
  let [lo, hi] = long ? [SLACK[0], 1] : [1, SLACK[1]];
  const edge = at(long ? lo : hi);
  if (long ? edge.seconds > MAX_SECONDS : edge.seconds < MIN_SECONDS)
    throw new Error(`the narration, spoken, runs ${edge.seconds} s even with its pauses and moves ${long ? "trimmed to the least" : "stretched to the most"}; a motion runs ${MIN_SECONDS}–${MAX_SECONDS} s, so its words need ${long ? "cutting" : "adding to"}`);
  // The slack that lands just inside the range: as little change as fits.
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    const fits = long ? at(mid).seconds <= MAX_SECONDS : at(mid).seconds >= MIN_SECONDS;
    if (fits === long) lo = mid;
    else hi = mid;
  }
  return at(long ? lo : hi);
}

// What the page and the masthead take from the issue.
export type Look = { label: string; project: string; date: string };
export const lookOf = (project: string, date: string): Look => ({ label: MOTION_TAB, project, date });

export type MotionProps = { storyboard: Storyboard; system: System; look: Look; voice: Voice };

// The lines' lengths estimated from their words, with nothing to hear: review rounds, and a silent motion.
export const estimated = (sb: Storyboard, speed = 1): Speech => {
  const paces = pacesOf(sb);
  return { rate: 24000, seconds: linesOf(sb).map((l, i) => estimate(l, speed * paces[i])), samples: [] };
};

// The spoken lines, or their estimated lengths when the voiceover is off.
export async function speechOf(props: MotionProps, speak: Speaker): Promise<Speech> {
  if (!props.voice.voiceover) return estimated(props.storyboard, props.voice.speed);
  return speak(linesOf(props.storyboard), props.voice.voice, props.voice.speed, pacesOf(props.storyboard));
}

// The moment for the poster and the last picture: the whole path traced, the closing line said, the end card up.
const settled = (tl: Timeline) => {
  const close = tl.beats[tl.beats.length - 1];
  return close.speak + close.speech + 0.6;
};

// The page's faces come from Google Fonts. They are fetched once into the cache and inlined, so every tab films with
// the same faces from its first frame and a render needs no network after the first. With neither, every tab draws
// the fallbacks.
const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=UnifrakturMaguntia&display=block";
// Google Fonts serves each browser the format it reads: asked as Chrome, it serves WOFF2.
const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
type Faces = { css: string; key: string };
let faces: Promise<Faces> | undefined;
export const fontFaces = () => (faces ??= fetchFaces());
async function fetchFaces(): Promise<Faces> {
  const dir = join(cacheDir(), "fonts");
  await mkdir(dir, { recursive: true });
  const get = async (url: string) => {
    const file = join(dir, createHash("sha256").update(url).digest("hex").slice(0, 16));
    if (await Bun.file(file).exists()) return Bun.file(file).bytes();
    const res = await fetch(url, { headers: { "user-agent": CHROME_UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    await Bun.write(`${file}.part`, body);
    await rename(`${file}.part`, file);
    return body;
  };
  try {
    const css = new TextDecoder().decode(await get(FONTS));
    let inlined = css;
    for (const url of new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)\s]+/g)))
      inlined = inlined.replaceAll(url, `data:font/woff2;base64,${Buffer.from(await get(url)).toString("base64")}`);
    return { css: inlined, key: css };
  } catch (e) {
    console.warn(`the motion's fonts didn't load from Google Fonts (${(e as Error).message}); it draws with the fallback faces`);
    return { css: "", key: "fallback" };
  }
}

const MOTION = join(ENGINE, "templates", "motion");
// Everything that changes the picture or the sound: the storyboard, the map as the tour reads it, the look, the
// voice, the engine's motion code, the layout library and the faces. The rendered files are named by it, so a new
// look renders again and an unchanged one is reused.
const CODE = ["src/motion.ts", "src/voice.ts", "src/speak.mjs", "src/layout.ts"];
export async function motionHash(props: MotionProps) {
  const { storyboard, look, voice } = props;
  const { parts, groups, edges } = meaningOf(props.system);
  const map = { parts: parts.map(({ id, name, sub }) => ({ id, name, sub })), groups, edges };
  const h = createHash("sha256").update(JSON.stringify({ storyboard, look, voice, map }));
  for (const f of (await readdir(MOTION)).sort()) h.update(f).update(await Bun.file(join(MOTION, f)).text());
  for (const f of CODE) h.update(await Bun.file(join(ENGINE, f)).text());
  h.update(await versionOf("elkjs")).update((await fontFaces()).key);
  if (voice.voiceover) h.update(await voiceVersion());
  return h.digest("hex").slice(0, 10);
}

// The map laid out, every beat a track.
export async function laidOut(props: MotionProps, tl: Timeline) {
  const { tour } = (await import(join(MOTION, "tour.layout.ts"))) as typeof import("../templates/motion/tour.layout");
  return tour({ storyboard: props.storyboard, system: props.system, look: props.look, timeline: tl });
}

// The page that draws it, with seek(ms) to show any moment.
export async function page(laid: Awaited<ReturnType<typeof laidOut>>) {
  const liquid = new Liquid({ root: [join(ENGINE, "templates")], extname: ".liquid", outputEscape: "escape", strictFilters: true });
  const read = (f: string) => Bun.file(join(MOTION, f)).text();
  // In a <script>, JSON is safe once nothing in it can close the element.
  const tracks = JSON.stringify(laid.tracks).replaceAll("<", "\\u003c");
  return liquid.renderFile("motion/tour", { f: laid.fields, fonts: (await fontFaces()).css, css: await read("tour.css"), js: await read("tour.js"), tracks });
}

type Shooter = { pages: Page[]; close: () => Promise<void> };

// n tabs of one headless Chrome on the page, each at `scale`, every face loaded.
async function shooter(html: string, scale: number, n: number): Promise<Shooter> {
  const browser = await (await import("./browser")).browser();
  const dir = await mkdtemp(join(tmpdir(), "daily-motion-page-"));
  const close = async () => {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const file = join(dir, "motion.html");
    await Bun.write(file, html);
    const pages: Page[] = [];
    for (let i = 0; i < n; i++) {
      const p = await browser.newPage({ viewport: { width: Math.round(WIDTH * scale), height: Math.round(HEIGHT * scale) } });
      await p.goto(`file://${file}`);
      await p.evaluate(async (s) => {
        (window as unknown as { setScale: (s: number) => void }).setScale(s);
        // Every face before the first frame, so no frame draws while one loads.
        await Promise.all([...document.fonts].map((f) => f.load()));
      }, scale);
      pages.push(p);
    }
    return { pages, close };
  } catch (e) {
    await close();
    throw e;
  }
}

const seekTo = (p: Page, ms: number) => p.evaluate((t) => (window as unknown as { seek: (t: number) => void }).seek(t), ms);

// ffmpeg (FFMPEG, else the one on the PATH) and its H.264 encoder: libx264 where the build has it (Ubuntu's, most
// static builds), else OpenH264 (Fedora's).
const ffmpeg = () => process.env.FFMPEG || "ffmpeg";
const encoders = new Map<string, string[]>();
function h264() {
  const bin = ffmpeg();
  const known = encoders.get(bin);
  if (known) return known;
  let list: string;
  try {
    list = Bun.spawnSync([bin, "-hide_banner", "-encoders"], { stderr: "ignore" }).stdout.toString();
  } catch {
    throw new Error(`the motion needs ffmpeg, and there is no "${bin}" on the PATH; install it, or set FFMPEG`);
  }
  // CRF 28 keeps a minute near 3 MB; aq-mode 3 spends bits on the dark, flat areas, where banding would show.
  const args = /\blibx264\b/.test(list)
    ? ["-c:v", "libx264", "-preset", "slow", "-crf", "28", "-tune", "animation", "-x264-params", "aq-mode=3"]
    : /\blibopenh264\b/.test(list)
      ? ["-c:v", "libopenh264", "-b:v", "400k"]
      : undefined;
  if (!args) throw new Error(`${bin} has no H.264 encoder (libx264 or libopenh264)`);
  encoders.set(bin, args);
  return args;
}

// Films frames from..to, each tab every n-th, and writes them to `sink` in order. A tab waits for its turn to write,
// so no more than one frame a tab is held.
async function film(pages: Page[], from: number, to: number, sink: FileHandle) {
  const sessions = await Promise.all(pages.map((p) => p.context().newCDPSession(p)));
  let next = from;
  const turns = new Map<number, () => void>();
  let failed: unknown;
  await Promise.all(
    pages.map(async (p, w) => {
      try {
        for (let f = from + w; f <= to && !failed; f += pages.length) {
          await seekTo(p, (f * 1000) / FPS);
          const { data } = await sessions[w].send("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true });
          // A tab that finished its shot after another failed would wait for a turn no one gives.
          if (f !== next && !failed) await new Promise<void>((r) => turns.set(f, r));
          if (failed) return;
          await sink.write(Buffer.from(data, "base64"));
          turns.get(++next)?.();
          turns.delete(next);
        }
      } catch (e) {
        failed ??= e;
        for (const r of turns.values()) r();
      }
    }),
  );
  if (failed) throw failed;
}

export type Made = { video: string; poster: string; timing: string; ms: number; frames: number; seconds: number; starts: number[] };
export const filesOf = (hash: string) => ({ video: `motion.${hash}.mp4`, poster: `motion.${hash}.jpg`, timing: `motion.${hash}.json` });

// The motion as an MP4 (H.264, yuv420p, AAC voice) and a poster: the closing pull-back, the whole path traced.
// They are made in a scratch folder and moved beside the page only once whole. `frames` renders only part of it,
// `scale` smaller, for tests.
export async function renderMotion(props: MotionProps, outDir: string, speak: Speaker, opts: { scale?: number; frames?: [number, number]; workers?: number } = {}): Promise<Made> {
  const scale = opts.scale ?? 1;
  const names = filesOf(await motionHash(props));
  const started = performance.now();
  const speech = await speechOf(props, speak);
  const tl = fitted(props.storyboard, speech.seconds);
  const starts = startsOf(tl);
  const [from, to] = opts.frames ?? [0, Math.round(tl.seconds * FPS) - 1];
  const count = to - from + 1;
  const work = await mkdtemp(join(tmpdir(), "daily-motion-"));
  const at = (f: string) => join(work, f);
  let shoot: Shooter | undefined;
  try {
    shoot = await shooter(await page(await laidOut(props, tl)), scale, Math.max(1, Math.min(opts.workers ?? 4, count)));
    // ffmpeg reads the frames from a FIFO, through files rather than Bun's pipes (see spawnIn).
    const args = [ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-"];
    if (speech.samples.length) {
      await Bun.write(at("voice.pcm"), voiceTrack(speech, starts, tl.seconds + 1));
      args.push("-ss", String(from / FPS), "-f", "s16le", "-ar", String(speech.rate), "-ac", "1", "-i", at("voice.pcm"), "-c:a", "aac", "-b:a", "80k", "-shortest");
    }
    args.push(...h264(), "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", at(names.video));
    if (Bun.spawnSync(["mkfifo", at("in")]).exitCode !== 0) throw new Error(`mkfifo failed in ${work}`);
    const encoded = spawnIn(work, args, { ms: 30 * 60_000 });
    // Awaited below; a timeout meanwhile must not end the process as unhandled.
    encoded.catch(() => {});
    // The shell opens the FIFO to read before it starts ffmpeg, so this open always meets it.
    const sink = await open(at("in"), "w");
    let filmed: unknown;
    try {
      await film(shoot.pages, from, to, sink);
    } catch (e) {
      filmed = e;
    } finally {
      await sink.close();
    }
    // When ffmpeg fails, the frames can't be written either: its own words say why.
    const { code, err } = await encoded;
    if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${err.trim().split("\n").slice(-3).join(" ")}`);
    if (filmed) throw filmed;
    // The poster: the whole map with the path traced, before the end card.
    await seekTo(shoot.pages[0], settled(tl) * 1000);
    await shoot.pages[0].screenshot({ path: at(names.poster), type: "jpeg", quality: 88 });
    await Bun.write(at(names.timing), `${JSON.stringify({ seconds: tl.seconds, starts })}\n`);
    await mkdir(outDir, { recursive: true });
    // The timing last: the three are reused only when it is there.
    for (const f of [names.video, names.poster, names.timing]) await Bun.write(join(outDir, f), Bun.file(at(f)));
    return { ...names, ms: Math.round(performance.now() - started), frames: count, seconds: tl.seconds, starts };
  } finally {
    await shoot?.close();
    await rm(work, { recursive: true, force: true });
  }
}

// What the tab needs of a rendered motion: its files, its length, and when each line is spoken.
export type MotionFiles = { video: string; poster: string; seconds: number; starts: number[] };

// The motion's files beside the page, rendered unless they already are. Any other motion's files there are dropped,
// so they aren't published beside it; without a storyboard, all of them are.
export async function motionFiles(props: MotionProps | undefined, dir: string, speak: Speaker): Promise<MotionFiles | undefined> {
  const names = props ? filesOf(await motionHash(props)) : undefined;
  const mine = new Set(Object.values(names ?? {}));
  for (const f of await readdir(dir).catch(() => [])) if (/^motion\.[0-9a-f]{10}\.(mp4|jpg|json)$/.test(f) && !mine.has(f)) await rm(join(dir, f));
  if (!props || !names) return undefined;
  if ((await Promise.all([...mine].map((f) => Bun.file(join(dir, f)).exists()))).every(Boolean)) {
    const { seconds, starts } = (await Bun.file(join(dir, names.timing)).json()) as { seconds: number; starts: number[] };
    return { video: names.video, poster: names.poster, seconds, starts };
  }
  const made = await renderMotion(props, dir, speak);
  console.log(`rendered ${join(dir, made.video)}: ${made.seconds} s, ${made.frames} frames in ${(made.ms / 1000).toFixed(0)} s`);
  return { video: made.video, poster: made.poster, seconds: made.seconds, starts: made.starts };
}

// Runs in the page, like look's measure for reels: each edge label as drawn, against the other labels, the parts'
// boxes and the lines of other edges. Text on any of them fails the render gate.
function overlaps() {
  const inside = (b: DOMRect, x: number, y: number) => x > b.x + 1 && x < b.x + b.width - 1 && y > b.y + 2 && y < b.y + b.height - 2;
  const hits = (a: DOMRect, b: DOMRect) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 2 && b.y < a.y + a.height - 2;
  const labels = [...document.querySelectorAll<SVGTextElement>("text.elabel")].map((t) => ({ t, b: t.getBBox(), own: t.id.replace("elabel-", "edge-") }));
  const boxes = [...document.querySelectorAll<SVGRectElement>(".part .box")].map((r) => ({ name: r.parentElement?.querySelector(".name")?.textContent ?? "", b: r.getBBox() }));
  const edges = [...document.querySelectorAll<SVGPathElement>("path.edge")];
  const out: string[] = [];
  for (const [i, { t, b, own }] of labels.entries()) {
    const text = t.textContent ?? "";
    for (const o of labels.slice(i + 1)) if (hits(b, o.b)) out.push(`"${text}" overlaps "${o.t.textContent}"`);
    for (const x of boxes) if (hits(b, x.b)) out.push(`"${text}" overlaps ${x.name}`);
    for (const e of edges) {
      if (e.id === own) continue;
      const len = e.getTotalLength();
      for (let d = 0; d <= len; d += 4) {
        const p = e.getPointAtLength(d);
        if (inside(b, p.x, p.y)) {
          out.push(`"${text}" lies on another edge's line`);
          break;
        }
      }
    }
  }
  // Inside each opened part, every word clear of every other.
  for (const card of document.querySelectorAll(".card")) {
    const texts = [...card.querySelectorAll<SVGTextElement>("text")].filter((t) => t.textContent?.trim()).map((t) => ({ t, b: t.getBBox() }));
    for (const [i, x] of texts.entries()) for (const y of texts.slice(i + 1)) if (hits(x.b, y.b)) out.push(`in ${card.querySelector(".cname")?.textContent}, "${x.t.textContent}" overlaps "${y.t.textContent}"`);
  }
  return out;
}

// Pictures for the Viewer: the opening map, a few stops as they are spoken, and the closing pull-back. The Viewer
// doesn't hear the voice, so a review round is timed by the estimate and nothing is spoken.
export async function stills(props: MotionProps, outDir: string, scale = 0.5) {
  const sb = props.storyboard;
  const tl = timeline(sb, estimated(sb, props.voice.speed).seconds);
  await mkdir(outDir, { recursive: true });
  const stops = tl.beats.filter((b) => b.kind === "stop");
  // The stops that show how it works first, then the first, middle and last: three in all, in order.
  const shown = stops.filter((b) => moveOf(sb.stops[b.index])).map((b) => b.index);
  const pick = [...new Set([...shown, 0, Math.floor(stops.length / 2), stops.length - 1])]
    .slice(0, 3)
    .sort((a, b) => a - b)
    .map((i) => stops[i]);
  const moments: [string, number][] = [
    ["the opening map", tl.beats[0].end - 0.2],
    // An opened part as its move finishes, failure branches and all; another as its line is mostly said.
    ...pick.map((b): [string, number] => {
      const m = moveOf(sb.stops[b.index]);
      return [`stop ${b.index + 1} (${sb.stops[b.index].part})${m ? `, its ${m.move} played` : ""}`, m ? b.end - 0.5 : b.speak + Math.min(b.speech * 0.7, b.end - b.speak - 0.2)];
    }),
    ["the closing pull-back", settled(tl)],
  ];
  const laid = await laidOut(props, tl);
  const shoot = await shooter(await page(laid), scale, 1);
  try {
    const p = shoot.pages[0];
    const pictures: { label: string; path: string }[] = [];
    for (const [i, [label, s]] of moments.entries()) {
      const path = join(outDir, `still-${i + 1}.png`);
      await seekTo(p, s * 1000);
      await p.screenshot({ path });
      pictures.push({ label, path });
    }
    return { pictures, seconds: tl.seconds, timeline: tl, overlaps: await p.evaluate(overlaps), legibility: laid.legibility, moves: laid.moves };
  } finally {
    await shoot.close();
  }
}
