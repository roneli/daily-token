import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnText } from "./harness/model";
import { ENGINE, readJson } from "./issue";

// The Cutaway's voiceover: Kokoro, an open text-to-speech model (Apache-2.0), on the CPU, in a Node subprocess
// (src/speak.mjs). Every line is kept in the cache by its words and voice, so the stage's gate and render speak
// each line once.

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";
// Kokoro speaks at 24 kHz; speak.mjs fails on anything else.
const RATE = 24000;
const DEFAULT_VOICE = "af_heart";
// A touch quicker than Kokoro's 1.0, which reads an explainer slowly.
const DEFAULT_SPEED = 1.08;

export type Voice = { voiceover: boolean; voice: string; speed: number };
// Each line's samples (mono float32 at `rate`) and length; a line not spoken has none.
export type Speech = { rate: number; seconds: number[]; samples: Float32Array[] };
export type Speaker = (lines: string[], voice: string, speed: number) => Promise<Speech>;

export const voiceOf = (c?: { voice?: string; voiceover?: boolean; speed?: number }): Voice => ({ voiceover: c?.voiceover ?? true, voice: c?.voice ?? DEFAULT_VOICE, speed: c?.speed ?? DEFAULT_SPEED });

// Where the model, the spoken lines and the motion's fonts are kept between runs: DAILY_TOKEN_CACHE, else
// ~/.cache/daily-token.
export const cacheDir = () => process.env.DAILY_TOKEN_CACHE || join(homedir(), ".cache", "daily-token");

// An installed package's name and version.
export const versionOf = async (name: string) => `${name}@${(await readJson<{ version: string }>(Bun.resolveSync(`${name}/package.json`, ENGINE))).version}`;

// What else changes how a line sounds: the package and the model.
export const voiceVersion = async () => `${await versionOf("kokoro-js")} ${MODEL} ${DTYPE}`;

export const kokoro: Speaker = async (lines, voice, speed) => {
  const dir = join(cacheDir(), "speech");
  await mkdir(dir, { recursive: true });
  const version = await voiceVersion();
  const files = lines.map((text) => join(dir, `${createHash("sha256").update(`${version}\n${voice}\n${speed}\n${text}`).digest("hex").slice(0, 16)}.f32`));
  const missing: { text: string; out: string }[] = [];
  for (const [i, out] of files.entries()) if (!(await Bun.file(out).exists())) missing.push({ text: lines[i], out });
  if (missing.length) {
    const job = { kokoro: Bun.resolveSync("kokoro-js", ENGINE), cache: join(cacheDir(), "models"), model: MODEL, dtype: DTYPE, rate: RATE, voice, speed, lines: missing };
    // Through files, not pipes: Bun has been seen to miss a child's exit (see spawnIn).
    const { code, err } = await spawnText([process.env.NODE || "node", join(ENGINE, "src", "speak.mjs")], JSON.stringify(job), { ms: 15 * 60_000 });
    if (code === 127) throw new Error("the voiceover needs Node 20 or later on the PATH (Kokoro doesn't run under Bun); install it, or set pipeline.motion.voiceover to false");
    if (code !== 0) throw new Error(`Kokoro failed: ${err.trim().split("\n").slice(-3).join(" ")}`);
  }
  const samples = await Promise.all(files.map(async (f) => trim(new Float32Array(await Bun.file(f).arrayBuffer()))));
  return { rate: RATE, samples, seconds: samples.map((s) => s.length / RATE) };
};

// A clip without the silence Kokoro leaves around it (quieter than 0.02), but a breath of it (60 ms): the beats put
// their own pauses between sentences, so a line said in pieces sounds like one.
function trim(samples: Float32Array): Float32Array {
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < 0.02) a++;
  while (b > a && Math.abs(samples[b]) < 0.02) b--;
  const pad = Math.round(0.06 * RATE);
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad + 1));
}

// One track of the whole motion: each line at its time, as raw 16-bit mono PCM (little-endian) at the speech's rate.
export function voiceTrack(speech: Speech, at: number[], seconds: number): Int16Array {
  const pcm = new Int16Array(Math.ceil(seconds * speech.rate));
  for (const [i, s] of speech.samples.entries()) {
    const from = Math.round(at[i] * speech.rate);
    for (let k = 0; k < s.length && from + k < pcm.length; k++) pcm[from + k] = Math.max(-32768, Math.min(32767, Math.round(s[k] * 32767)));
  }
  return pcm;
}
