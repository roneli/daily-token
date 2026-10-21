import { expect, test } from "bun:test";
import { join } from "node:path";
import { settings } from "./cli";
import { ENGINE } from "./issue";

test("--set reads stage.key=value, with JSON values", () => {
  expect(settings(["reels.reviewers=[]", "reels.rounds=2", "stories.budgetUsd=1.5"])).toEqual({ reels: { reviewers: [], rounds: 2 }, stories: { budgetUsd: 1.5 } });
  expect(() => settings(["rounds=2"])).toThrow("stage.key=value");
});

test("the CLI prints its commands, and fails on one it doesn't know", async () => {
  const cli = join(ENGINE, "src", "cli.ts");
  const help = Bun.spawnSync(["bun", cli, "help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("run       Make one day's issue");
  expect(Bun.spawnSync(["bun", cli, "nope"]).exitCode).toBe(1);
});

test("check runs through the CLI on the fixture", () => {
  const r = Bun.spawnSync(["bun", join(ENGINE, "src", "cli.ts"), "check", "--root", join(ENGINE, "fixtures", "sample")]);
  expect(r.stdout.toString()).toContain("check passed");
});

