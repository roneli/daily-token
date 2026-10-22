import { expect, test } from "bun:test";
import { join } from "node:path";
import { filesFor, partsFor, readerOf } from "./excerpts";
import { ENGINE, readJson, type System } from "./issue";

const system = await readJson<System>(join(ENGINE, "fixtures", "sample", "system.json"));

test("the parts to read are the ones the topic names, else the ones today touched", () => {
  expect(partsFor(system, "How the countdown holds the clamps until the gyro is ready", [])).toEqual(["launchpad", "guidance"]);
  expect(partsFor(system, "something no part mentions", ["engine", "ci"])).toEqual(["engine", "ci"]);
  expect(partsFor(system, undefined, [])).toEqual([]);
});

test("a part's files: docs first, then paths that name the topic, then the shallowest; no tests or generated code", () => {
  const paths = ["pad/clamps/release.ts", "pad/README.md", "pad/countdown.ts", "pad/countdown.test.ts", "pad/gen/api.ts", "pad/logo.png", "engine/burn.ts", "ground:screen/clock.ts"];
  expect(filesFor(paths, ["pad/**", "ground:screen/**"], "how the clamps let go")).toEqual(["pad/README.md", "pad/clamps/release.ts", "pad/countdown.ts", "ground:screen/clock.ts"]);
});

test("the reader fetches each part's files from its repo, within the budget", async () => {
  const trees: Record<string, string[]> = { "acme/rocket": ["pad/README.md", "pad/countdown.ts", "engine/burn.ts"], "acme/ground": ["screen/clock.ts"] };
  const read = readerOf(
    async (repo) => trees[repo],
    async (repo, path) => `${repo}/${path} `.repeat(4000),
  );
  const got = await read({ system, repos: ["acme/rocket", "acme/ground"], topic: "the countdown on the launch pad", touched: [] });
  expect(got.map((x) => `${x.part} ${x.from}`)).toEqual(["launchpad acme/rocket:pad/README.md", "launchpad acme/rocket:pad/countdown.ts", "launchpad acme/ground:screen/clock.ts"]);
  expect(got.every((x) => x.text.length <= 6_000 + 10)).toBe(true);
});
