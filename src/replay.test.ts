import { expect, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scripted } from "./harness/model";
import { ENGINE, type Reels } from "./issue";
import { replay, table } from "./replay";
import { directorFrom } from "./stages/stages.test";

const DATE = "2026-01-15";

test("replay remakes one stage in a scratch root and leaves the real issue alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const dir = join(root, "issues", DATE);
  const reels = (await Bun.file(join(dir, "reels.json")).json()) as Reels;
  const director = directorFrom(reels.threads);
  await Bun.write(join(dir, "review.json"), JSON.stringify({ reels: { stop: "passed", costUsd: 1.5, rounds: [{ score: 3.2 }, { score: 4.6 }] } }));
  const before = await Bun.file(join(dir, "reels.json")).text();

  const r = await replay({ root, date: DATE, stage: "reels", set: { reels: { reviewers: [], gates: ["check"], maxShorts: 5 } }, model: scripted({ director: Array(4).fill(director) }) });

  expect(r.after?.stop).toBe("partly");
  expect(r.before?.costUsd).toBe(1.5);
  expect(r.scratch.startsWith(root)).toBe(false);
  expect(await Bun.file(join(dir, "reels.json")).text()).toBe(before);
  expect(((await Bun.file(join(r.scratch, "reels.json")).json()) as Reels).threads.map((t) => t.id)).toEqual(["recap", "launch", "other", "next"]);
  expect(table("reels", ["reels.reviewers=[]"], r.before, r.after)).toContain("3.20 → 4.60");
});

test("a replayed stage that grades nothing shows nothing from the first run", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  await Bun.write(join(root, "issues", DATE, "review.json"), JSON.stringify({ verify: { stop: "passed", rounds: [] } }));
  const r = await replay({ root, date: DATE, stage: "verify", set: {}, model: scripted({}) });
  expect(r.before?.stop).toBe("passed");
  expect(r.after).toBeUndefined();
});
