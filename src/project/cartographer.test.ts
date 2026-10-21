import { expect, mock, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scripted } from "../harness/model";
import { ENGINE, type Project, readJson, type System } from "../issue";
import { meaningOf } from "../layout";
import * as github from "../sources/github/collect";

// No network: the repo's folders come from a made-up tree.
mock.module("../sources/github/collect", () => ({ ...github, rest: async () => ({ tree: [{ path: "src/engine/burn.ts", type: "blob" }] }) }));
const { cartographer } = await import("./cartographer");

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "cartographer-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const day = join(root, "issues", "2026-01-15", "data.json");
  const data = await Bun.file(day).json();
  await Bun.write(day, JSON.stringify({ ...data, sources: { github: { ...data.sources.github, unmatched: ["tools/lint.sh"] } } }));
  const [project, system] = await Promise.all([readJson<Project>(join(root, "project.json")), readJson<System>(join(root, "system.json"))]);
  return { root, project, system };
};

test("the Cartographer must place or ignore every unmatched file, and a same structure keeps the drawing", async () => {
  const { root, project, system } = await setup();
  const meaning = meaningOf(system);
  const proposal = (ignore: string[]) => ({ ...meaning, parts: meaning.parts.map((p) => ({ ...p, paths: p.paths ?? [] })), ignore, notes: [{ change: "ignore tools", why: "scripts" }] });
  const model = scripted({ cartographer: [proposal([]), proposal(["tools/**"])] });
  const traced: string[] = [];
  await cartographer.run({ root, project, system, model, log: () => {}, trace: async (name) => traced.push(name) }, { days: "7", accept: false });

  expect(model.sent.cartographer[0]).toContain("tools/lint.sh");
  expect(model.sent.cartographer[1]).toContain("1 files still match no part");
  const proposed = await readJson<System>(join(root, "system.proposed.json"));
  expect(proposed.ignore).toEqual(["tools/**"]);
  expect(proposed.parts.map((p) => p.box)).toEqual(system.parts.map((p) => p.box));
  expect((await readJson<{ kept: boolean }>(join(root, "map.json"))).kept).toBe(true);
  expect(traced).toEqual(["input", "1-cartographer"]);

  await cartographer.run({ root, project, system, model, log: () => {}, trace: async () => {} }, { accept: true });
  expect((await readJson<System>(join(root, "system.json"))).ignore).toEqual(["tools/**"]);
  expect(await Bun.file(join(root, "system.proposed.json")).exists()).toBe(false);
});
