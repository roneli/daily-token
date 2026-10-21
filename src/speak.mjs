// The voiceover, spoken by Kokoro (kokoro-js, Apache-2.0) on the CPU. It runs under Node, not Bun: onnxruntime's
// packages don't resolve under Bun. stdin: { kokoro, cache, model, dtype, rate, voice, speed, lines: [{ text, out }] }.
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
const { KokoroTTS } = await import(pathToFileURL(job.kokoro).href);
const tts = await KokoroTTS.from_pretrained(job.model, { dtype: job.dtype, device: "cpu" });

for (const line of job.lines) {
  const audio = await tts.generate(line.text, { voice: job.voice, speed: job.speed });
  if (audio.sampling_rate !== job.rate) throw new Error(`Kokoro spoke at ${audio.sampling_rate} Hz, not ${job.rate}`);
  const samples = audio.audio;
  // A line cut off mid-write would be kept as spoken; a whole file is renamed into place.
  await writeFile(`${line.out}.part`, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  await rename(`${line.out}.part`, line.out);
}
