import { expect, mock, test } from "bun:test";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCtx } from "../harness/context";
import { scripted } from "../harness/model";
import { ENGINE, type Project, readJson, type System, writeJson } from "../issue";
import * as github from "../sources/github/collect";
import { day } from "../stages/day";

// No network: the repo holds a README and a source file, and every file reads as the README.
const README = "# Rocket\nRocket burns fuel on a schedule. The countdown is the launch timer.";
mock.module("../sources/github/collect", () => ({
  ...github,
  rest: async (path: string) =>
    path.includes("/git/trees/") ? { tree: [{ path: "src/engine/burn.ts", type: "blob" }, { path: "README.md", type: "blob" }] } : { content: Buffer.from(README).toString("base64"), encoding: "base64" },
}));
const { briefer, docPaths, ungrounded } = await import("./briefer");

test("docs are picked by name and ranked: a glossary, the root README, then deeper docs", () => {
  const paths = ["src/a.ts", "README.md", "docs/GLOSSARY.md", "apps/web/README.md", "docs/architecture.md", "node_modules/x/README.md", "a/b/c/README.md", "CLAUDE.md", ".github/README.md"];
  expect(docPaths(paths)).toEqual(["docs/GLOSSARY.md", "README.md", "CLAUDE.md", "docs/architecture.md", "apps/web/README.md"]);
});

test("a name or term must appear in what was read, once", () => {
  const brief = { about: "x".repeat(20), names: [{ name: "Rocket", is: "the app", aka: ["rkt"] }], terms: [{ term: "countdown", plain: "launch timer" }, { term: "Countdown", plain: "again" }] };
  expect(ungrounded(brief, "Rocket and its countdown")).toEqual([
    '"rkt" appears in none of the docs or recent PRs; drop it or use the word they use',
    '"Countdown" is listed twice; keep one entry',
  ]);
});

test("the Briefer reads the chosen docs and the repo's, is held to them, and its accepted brief reaches the agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "briefer-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  await mkdir(join(root, "notes"));
  await Bun.write(join(root, "notes", "brief.md"), "Partners call the scheduler the burn planner.");
  const project = { ...(await readJson<Project>(join(root, "project.json"))), brief: { docs: ["notes/brief.md"] } };
  await writeJson(join(root, "project.json"), project);
  const system = await readJson<System>(join(root, "system.json"));

  const brief = (aka: string) => ({ about: "Rocket schedules fuel burns for small launch teams.", names: [{ name: "Rocket", is: "the app", aka: [aka] }], terms: [{ term: "countdown", plain: "the launch timer" }] });
  const model = scripted({ briefer: [{ brief: brief("thruster"), notes: [] }, { brief: brief("burn planner"), notes: [{ change: "add Rocket", why: "README" }] }] });
  await briefer.run({ root, project, system, model, log: () => {}, trace: async () => {} }, { days: "10", accept: false });

  expect(model.sent.briefer[0]).toContain("Partners call the scheduler");
  expect(model.sent.briefer[0]).toContain("The countdown is the launch timer");
  expect(model.sent.briefer[1]).toContain('"thruster" appears in none of the docs');
  const proposed = await readJson<{ from: string[] }>(join(root, "brief.proposed.json"));
  expect(proposed.from).toEqual(["notes/brief.md", "acme/rocket:README.md", "acme/ground:README.md"]);

  await briefer.run({ root, project, system, model, log: () => {}, trace: async () => {} }, { days: "10", accept: true });
  expect(await Bun.file(join(root, "brief.proposed.json")).exists()).toBe(false);
  const ctx = await createCtx({ root, date: "2026-01-15", tz: "UTC", cutoff: "00:00", model: scripted({}) });
  expect((day(ctx, await ctx.read("data.json")) as { brief?: { about: string } }).brief?.about).toBe("Rocket schedules fuel burns for small launch teams.");
});

test("a brief.json that breaks the schema stops the run and shows in doctor", async () => {
  const root = await mkdtemp(join(tmpdir(), "briefer-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  await writeJson(join(root, "brief.json"), { about: "short", names: [] });
  expect(createCtx({ root, date: "2026-01-15", tz: "UTC", cutoff: "00:00", model: scripted({}) })).rejects.toThrow("brief.json");
  const { doctor } = await import("../doctor");
  const found = (await doctor(root, {})).find((f) => f.what === "brief.json");
  expect(found?.ok).toBe(false);
});
