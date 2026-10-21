import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scripted } from "./model";

const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };

test("an answer that breaks the schema goes back with its errors", async () => {
  const model = scripted({ a: [{ n: "one" }, { n: 1 }] });
  const { value, run } = await model.ask<{ n: number }>("a", { q: 1 }, schema);
  expect(value).toEqual({ n: 1 });
  expect(run.attempts).toBe(2);
  expect(model.sent.a[1]).toContain('"n": "one"');
  expect(model.sent.a[1]).toContain("/n must be number");
});

test("validate runs only on an answer that fits the schema", async () => {
  const seen: number[] = [];
  const model = scripted({ a: [{ n: "x" }, { n: 1 }, { n: 2 }] });
  const { value } = await model.ask<{ n: number }>("a", {}, schema, {
    validate: (v) => {
      seen.push(v.n);
      return v.n < 2 ? ["too small"] : [];
    },
  });
  expect(value.n).toBe(2);
  expect(seen).toEqual([1, 2]);
});

test("it gives up after the attempts, naming the last errors", async () => {
  const model = scripted({ a: [{}, {}] });
  expect(model.ask("a", {}, schema, { attempts: 2 })).rejects.toThrow("still failing after 2 attempts");
});

test("a failed call throws at once", async () => {
  const model = scripted({ a: [new Error("cli down"), { n: 1 }] });
  expect(model.ask("a", {}, schema)).rejects.toThrow("cli down");
});

test("a command gives back its output, errors and exit code", async () => {
  const { spawnText } = await import("./model");
  const r = await spawnText(["sh", "-c", "cat; echo done; echo oops >&2; exit 3"], "in ", { ms: 10_000 });
  expect(r).toEqual({ out: "in done\n", err: "oops\n", code: 3 });
});

test("a command that gives no answer in time is killed", async () => {
  const { spawnText, TimeoutError } = await import("./model");
  const started = performance.now();
  const mark = join(tmpdir(), `daily-late-${process.pid}`);
  await expect(spawnText(["sh", "-c", `sleep 1; touch ${mark}`], "", { ms: 200 })).rejects.toBeInstanceOf(TimeoutError);
  expect(performance.now() - started).toBeLessThan(1000);
  // The command itself is killed, not only the shell around it.
  await Bun.sleep(1500);
  expect(await Bun.file(mark).exists()).toBe(false);
});

test("a command whose shell is killed before it writes the exit code is reported, not waited on", async () => {
  const { spawnText, TimeoutError } = await import("./model");
  const started = performance.now();
  // The command kills the shell that would write its exit code, then ends itself.
  const r = spawnText(["sh", "-c", "kill -9 $PPID; exit 0"], "", { ms: 60_000, label: "test" });
  await expect(r).rejects.toBeInstanceOf(TimeoutError);
  await expect(r).rejects.toThrow("test ended without an exit code");
  expect(performance.now() - started).toBeLessThan(10_000);
});
