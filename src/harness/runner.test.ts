import { expect, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../issue";
import { createCtx } from "./context";
import { scripted } from "./model";
import { run, type Stage } from "./runner";

const DATE = "2026-01-15";
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  return root;
};
const stage = (name: string, makes: string[], ran: string[], result?: string): Stage => ({
  name, makes,
  async run(ctx) {
    ran.push(name);
    for (const f of makes) await ctx.write(f, { by: name });
    return result;
  },
});

test("--from skips earlier stages whose files are there, and reruns one whose file is missing", async () => {
  const root = await fixture();
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}) });
  const ran: string[] = [];
  await run(ctx, [stage("a", ["data.json"], ran), stage("b", ["b.json"], ran), stage("c", ["c.json"], ran)], { from: "c" });
  expect(ran).toEqual(["b", "c"]);
  expect(await ctx.read("data.json")).not.toEqual({ by: "a" });
});

test("stop ends the run, and meta.json adds this pass's runs to the last", async () => {
  const root = await fixture();
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}) });
  await ctx.write("meta.json", { runs: [{ agent: "old" }], reviews: { stories: { stop: "passed" } } });
  ctx.meta.reviews = { reels: { stop: "rounds" } };
  ctx.runs.push({ agent: "new", model: "m", attempts: 1, ms: 1, costUsd: 0.5, errors: [] });
  const ran: string[] = [];
  const r = await run(ctx, [stage("a", [], ran, "stop"), stage("b", [], ran)]);
  expect(ran).toEqual(["a"]);
  expect(r.stopped).toBe("a");
  const meta = await ctx.read<{ runs: { agent: string }[]; costUsd: number; reviews: object }>("meta.json");
  expect(meta.runs.map((x) => x.agent)).toEqual(["old", "new"]);
  expect(meta.costUsd).toBe(0.5);
  expect(meta.reviews).toEqual({ stories: { stop: "passed" }, reels: { stop: "rounds" } });
});

test("an unknown stage name is refused", async () => {
  const ctx = await createCtx({ root: await fixture(), date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}) });
  expect(run(ctx, [stage("a", [], [])], { from: "nope" })).rejects.toThrow("no stage nope");
});

test("--set overrides a stage's config from project.json", async () => {
  const root = await fixture();
  const project = await Bun.file(join(root, "project.json")).json();
  await Bun.write(join(root, "project.json"), JSON.stringify({ ...project, pipeline: { reels: { rounds: 2, reviewers: ["reader"] } } }));
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}), set: { reels: { reviewers: [] } } });
  expect(ctx.pipeline.reels).toEqual({ rounds: 2, reviewers: [] });
});

test("an issue with every stage's files runs only from --from", async () => {
  const root = await fixture();
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}) });
  const { daily } = await import("../pipeline");
  const ran: string[] = [];
  const spied = daily.map((s) => ({ ...s, run: async () => void ran.push(s.name) }));
  await run(ctx, spied, { from: "verify" });
  expect(ran).toEqual(["verify"]);
});

test("--from after --to is refused, and a check from an earlier pass is dropped", async () => {
  const ctx = await createCtx({ root: await fixture(), date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}) });
  expect(run(ctx, [stage("a", [], []), stage("b", [], [])], { from: "b", to: "a" })).rejects.toThrow("comes after");
  await ctx.write("meta.json", { check: { errors: ["old"] }, leftOut: [] });
  const { meta } = await run(ctx, [stage("a", [], [])]);
  expect(meta.check).toBeUndefined();
});

test("a --set value the project schema refuses fails before anything runs", async () => {
  expect(createCtx({ root: await fixture(), date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}), set: { reels: { rounds: Number("x") } } })).rejects.toThrow("pipeline config");
});
