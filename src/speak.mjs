// The voiceover, spoken by Kokoro (kokoro-js, Apache-2.0) on the CPU. It runs under Node, not Bun: onnxruntime's
// packages don't resolve under Bun. stdin: { kokoro, cache, model, dtype, rate, voice, lines: [{ text, out, speed }] }.
// Each line becomes raw 32-bit float mono samples at `out`, written whole or not at all.
import { rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));

// The model is downloaded once into `cache` (the transformers instance kokoro-js imports, so the setting holds).
const transformers = join(dirname(createRequire(job.kokoro).resolve("@huggingface/transformers")), "transformers.node.mjs");
const { env } = await import(pathToFileURL(transformers).href);
env.cacheDir = job.cache;
const { KokoroTTS, TextSplitterStream } = await import(pathToFileURL(job.kokoro).href);
const tts = await KokoroTTS.from_pretrained(job.model, { dtype: job.dtype, device: "cpu" });

// A weak "a" after a vowel sound glides into it ("how a" comes out "howa"), so it is said in full, "ay". Kokoro says
// each sentence of a line; one the rule changes is said again from the changed sounds.
const strongA = (ph) => ph.replace(/(aʊ|aɪ|oʊ|eɪ|ɔɪ|uː|iː|ɑː|ɔː) ɐ(?= )/g, "$1 ˈeɪ");

async function say(text, speed) {
  const split = new TextSplitterStream();
  split.push(text);
  split.close();
  const parts = [];
  for await (const { phonemes, audio } of tts.stream(split, { voice: job.voice, speed })) {
    const fixed = strongA(phonemes);
    if (fixed === phonemes) parts.push(audio);
    else parts.push(await tts.generate_from_ids(tts.tokenizer(fixed, { truncation: true }).input_ids, { voice: job.voice, speed }));
  }
  const samples = new Float32Array(parts.reduce((n, a) => n + a.audio.length, 0));
  let at = 0;
  for (const a of parts) {
    samples.set(a.audio, at);
    at += a.audio.length;
  }
  return { sampling_rate: parts[0]?.sampling_rate ?? job.rate, audio: samples };
}

for (const line of job.lines) {
  const audio = await say(line.text, line.speed);
  if (audio.sampling_rate !== job.rate) throw new Error(`Kokoro spoke at ${audio.sampling_rate} Hz, not ${job.rate}`);
  const samples = audio.audio;
  // A line cut off mid-write would be kept as spoken; a whole file is renamed into place.
  await writeFile(`${line.out}.part`, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  await rename(`${line.out}.part`, line.out);
}
