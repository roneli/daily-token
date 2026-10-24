import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minutes, stageTimes, took, usualTimes } from "./progress";

test("a stage's time is what the run recorded, else its agents' times, reels shared by the threads at once", () => {
  expect(stageTimes({ stages: { stories: 1000 }, runs: [{ agent: "writer", ms: 9 }] })).toEqual({ stories: 1000 });
  expect(stageTimes({ runs: [{ agent: "writer", ms: 60_000 }, { agent: "editor", ms: 30_000 }, { agent: "director", ms: 90_000 }, { agent: "reader", ms: 30_000 }, { agent: "briefer", ms: 5 }] })).toEqual({ stories: 90_000, reels: 40_000 });
});

test("the usual time is the median over the last issues, and is said in minutes", async () => {
  const root = await mkdtemp(join(tmpdir(), "progress-"));
  for (const [d, ms] of [["2026-01-12", 60_000], ["2026-01-13", 240_000], ["2026-01-14", 180_000], ["2026-01-15", 1]] as [string, number][]) {
    await mkdir(join(root, "issues", d), { recursive: true });
    await Bun.write(join(root, "issues", d, "meta.json"), JSON.stringify({ stages: { stories: ms } }));
  }
  // The 15th is the issue being made: only the ones before it count.
  const usual = await usualTimes(root, "2026-01-15");
  expect(usual.stories).toBe(180_000);
  // A stage never timed here gets a first guess.
  expect(usual.motion).toBeGreaterThan(0);
  expect(minutes(180_000)).toBe("about 3 min");
  expect(minutes(20_000)).toBe("under a minute");
  expect(took(222_000)).toBe("3 min 42 s");
});
