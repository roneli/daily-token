import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../issue";
import { errorsOf } from "./schema";

// A Model answers one agent: a prompt file, JSON in, JSON out against a schema.
// Answers that break the schema or `validate` go back to the agent with the errors, up to `attempts` times.

export type Run = { agent: string; model: string; attempts: number; ms: number; costUsd: number; errors: string[] };

// images: PNG paths sent with the input, in order, for an agent that should see what readers see.
export type AskOpts<T> = { model?: string; attempts?: number; images?: string[]; validate?: (value: T) => Promise<string[]> | string[] };

export interface Model {
  ask<T>(agent: string, input: unknown, schema: object, opts?: AskOpts<T>): Promise<{ value: T; run: Run }>;
}

// One call to the model behind a Model: the message so far in, an answer and its cost out.
type Call = (c: { agent: string; model: string; message: string; images: string[]; schema: object }) => Promise<{ value: unknown; costUsd: number }>;

function retrying(call: Call): Model {
  return {
    async ask<T>(agent: string, input: unknown, schema: object, opts: AskOpts<T> = {}) {
      const model = opts.model ?? process.env[`MODEL_${agent.toUpperCase()}`] ?? process.env.AGENT_MODEL ?? "opus";
      const run: Run = { agent, model, attempts: 0, ms: 0, costUsd: 0, errors: [] };
      const asked = `Input:\n\`\`\`json\n${JSON.stringify(input, null, 1)}\n\`\`\``;
      let message = asked;
      for (let i = 0; i < (opts.attempts ?? 3); i++) {
        run.attempts++;
        const started = performance.now();
        const { value, costUsd } = await call({ agent, model, message, images: opts.images ?? [], schema });
        run.ms += Math.round(performance.now() - started);
        run.costUsd += costUsd;
        const shape = errorsOf(schema, value);
        const errors = shape.length ? shape : await (opts.validate?.(value as T) ?? []);
        console.log(`[${agent}] attempt ${run.attempts}: ${errors.length ? `${errors.length} problems` : "ok"} (${(run.ms / 1000).toFixed(0)} s, $${run.costUsd.toFixed(2)})`);
        if (!errors.length) return { value: value as T, run };
        run.errors = errors;
        message = `${asked}\n\nYour previous answer:\n\`\`\`json\n${JSON.stringify(value, null, 1)}\n\`\`\`\n\nIt has these problems. Fix every one and return the whole answer again:\n${errors.map((e) => `- ${e}`).join("\n")}`;
      }
      throw new Error(`${agent}: still failing after ${run.attempts} attempts:\n${run.errors.join("\n")}`);
    },
  };
}

export class TimeoutError extends Error {}

// Runs a command with stdin, and returns its output and exit code.
export async function spawnText(cmd: string[], stdin: string, o: { ms: number; label?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "daily-cmd-"));
  try {
    await Bun.write(join(dir, "in"), stdin);
    return await spawnIn(dir, cmd, o);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Runs a command on `dir/in` (a file, or a FIFO the caller writes) and returns its output and exit code. A shell runs
// it with files for its pipes and writes its exit code last; we wait for that file, not for Bun: Bun has been seen to
// miss a child's exit and its pipes closing, which held a call for the whole timeout and kept the run from ever
// exiting. Past `ms` it is killed.
export async function spawnIn(dir: string, cmd: string[], o: { ms: number; label?: string }) {
  const at = (name: string) => join(dir, name);
  const script = '"$@" < "$D/in" > "$D/out" 2> "$D/err" & echo $! > "$D/pid"; wait $!; echo $? > "$D/code.part" && mv "$D/code.part" "$D/code"';
  const shell = Bun.spawn(["sh", "-c", script, "sh", ...cmd], { cwd: tmpdir(), env: { ...process.env, D: dir }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  shell.unref();
  const pidOf = () => Number((existsSync(at("pid")) ? readFileSync(at("pid"), "utf8") : "").trim());
  // A zombie answers kill(0) but is gone: an orphan waits as one where its new parent doesn't reap, as on CI runners.
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return true;
    }
  };
  const label = o.label ?? cmd[0];
  const started = Date.now();
  // Waits with plain timers and synchronous checks: a run once stalled for good on an await in this loop, past its
  // deadline. The deadline has its own timer, so nothing in the loop can hold it back.
  const answer = await new Promise<"done" | "gone" | "late">((resolve) => {
    let gone = 0;
    const deadline = setTimeout(() => finish("late"), o.ms);
    const beat = setInterval(() => console.log(`[${label}] still waiting after ${Math.round((Date.now() - started) / 60_000)} min`), 5 * 60_000);
    const poll = setInterval(() => {
      if (existsSync(at("code"))) return finish("done");
      // The command ran and is gone, but no exit code came: the shell around it was killed.
      const pid = pidOf();
      gone = pid && !alive(pid) ? gone + 1 : 0;
      if (gone > 20) finish("gone");
    }, 100);
    function finish(how: "done" | "gone" | "late") {
      clearTimeout(deadline);
      clearInterval(beat);
      clearInterval(poll);
      resolve(how);
    }
  });
  if (answer !== "done") {
    for (const p of [pidOf(), shell.pid]) {
      try {
        if (p) process.kill(p, "SIGKILL");
      } catch {}
    }
    if (answer === "late") throw new TimeoutError(`${label} gave no answer in ${Math.round(o.ms / 1000)} s`);
    throw new TimeoutError(`${label} ended without an exit code`);
  }
  const [out, err, code] = await Promise.all(["out", "err", "code"].map((n) => Bun.file(at(n)).text()));
  return { out, err, code: Number(code.trim()) };
}

// The claude CLI, headless. Locally it uses the CLI's login; in CI ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
export const claudeCli: Model = retrying(async ({ agent, model, message, images, schema }) => {
  // With images the message goes in as one stream-json user turn: the pictures, then the text.
  const content = [
    ...(await Promise.all(images.map(async (p) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(await Bun.file(p).arrayBuffer()).toString("base64") } })))),
    { type: "text", text: message },
  ];
  const stdin = images.length ? `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n` : message;
  const args = [
    "claude", "-p", ...(images.length ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    "--json-schema", JSON.stringify(schema), "--system-prompt-file", join(ENGINE, "agents", `${agent}.md`), "--model", model,
    "--no-session-persistence", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
  ];
  // A Reader answers in under a minute; a Director may write a long scene.
  const limit = Number(process.env.AGENT_TIMEOUT_MIN ?? (agent === "reader" ? 5 : 20)) * 60_000;
  // A hung call is killed and asked once more; a second hang is an error.
  let r: Awaited<ReturnType<typeof spawnText>>;
  try {
    r = await spawnText(args, stdin, { ms: limit, label: agent });
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    console.log(`[${agent}] ${e.message}; asking again`);
    r = await spawnText(args, stdin, { ms: limit, label: agent });
  }
  const { out, err, code } = r;
  let result: { is_error?: boolean; structured_output?: unknown; total_cost_usd?: number; result?: string };
  try {
    // stream-json output is one event per line; the answer is the "result" event.
    result = images.length ? JSON.parse(out.trim().split("\n").filter((l) => l.includes('"type":"result"')).at(-1) ?? "") : JSON.parse(out);
  } catch {
    throw new Error(`${agent}: claude exited ${code} without JSON: ${(err || out).slice(0, 500)}`);
  }
  if (result.is_error || result.structured_output === undefined) throw new Error(`${agent}: ${result.result ?? "no structured output"}`);
  return { value: result.structured_output, costUsd: result.total_cost_usd ?? 0 };
});

// For tests: each agent answers from its queue, in order. An answer may be a function of what the agent was sent;
// a thrown Error stands for the CLI failing. `sent` records every message, per agent.
export type Script = Record<string, (unknown | ((message: string, images: string[]) => unknown))[]>;
export function scripted(script: Script, costUsd = 0.01): Model & { sent: Record<string, string[]> } {
  const sent: Record<string, string[]> = {};
  const model = retrying(async ({ agent, message, images }) => {
    sent[agent] = [...(sent[agent] ?? []), message];
    const next = script[agent]?.shift();
    if (next === undefined) throw new Error(`${agent}: the script has no answer left`);
    const value = typeof next === "function" ? next(message, images) : next;
    if (value instanceof Error) throw value;
    return { value, costUsd };
  });
  return { ...model, sent };
}
