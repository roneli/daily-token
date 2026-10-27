import { expect, test } from "bun:test";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor";
import { cron, init, nextSteps } from "./init";
import { ENGINE, MAX_STORIES, STORIES_CEILING } from "./issue";
import { answering } from "./prompter";

const ANSWERS = { name: "Rocket", sources: "github", "github.repos": "acme/rocket, acme/ground", "github.useGhToken": false, tz: "Europe/Berlin", cutoff: "18:30", days: "mon,tue,wed,thu,fri", weekly: "fri", model: "sonnet", publish: "s3", site: "" };

test("init writes a data root from the answers, and doctor accepts it", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "init-")), "rocket");
  const { plan, written } = await init(dir, answering(ANSWERS));
  expect(written.sort()).toEqual([".env", ".env.example", ".github/workflows/daily.yml", ".github/workflows/publish.yml", ".gitignore", "README.md", "mise.toml", "package.json", "project.json", "system.json"]);
  const daily = await Bun.file(join(dir, ".github", "workflows", "daily.yml")).text();
  expect(daily).toContain('cron: "30 16,17 * * 1,2,3,4,5"');
  expect(daily).toContain("bunx daily-token publish");
  expect(daily).not.toContain("# publish:");
  expect(await Bun.file(join(dir, "project.json")).json()).toEqual({ id: "rocket", name: "Rocket", sources: { github: { repos: ["acme/rocket", "acme/ground"] } }, days: ["mon", "tue", "wed", "thu", "fri"], weekly: "fri" });
  expect(await Bun.file(join(dir, ".env")).text()).toBe("DIGEST_TZ=Europe/Berlin\nCUTOFF=18:30\nAGENT_MODEL=sonnet\nS3_ENDPOINT=\nS3_BUCKET=daily-token\nS3_ACCESS_KEY_ID=\nS3_SECRET_ACCESS_KEY=\nSITE_URL=\n");
  expect((await Bun.file(join(dir, "package.json")).json()).dependencies["daily-token"]).toBe((await Bun.file(join(ENGINE, "package.json")).json()).version);
  expect(await readdir(join(dir, "issues"))).toEqual([]);
  expect(nextSteps(plan)).toContain("secret   S3_SECRET_ACCESS_KEY");
  const found = Object.fromEntries((await doctor(dir, {})).map((f) => [f.what, f.ok]));
  expect(found["project.json"]).toBe(true);
  expect(found["system.json"]).toBe(true);
});

test("init on an existing root converts it, keeps its files and answers, and only adds what's missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "init-"));
  await cp(join(ENGINE, "fixtures", "sample"), dir, { recursive: true });
  const { sources: _s, ...project } = await Bun.file(join(dir, "project.json")).json();
  await Bun.write(join(dir, "project.json"), JSON.stringify({ ...project, repos: ["acme/rocket", "acme/ground"], pipeline: { reels: { rounds: 2 } } }));
  await Bun.write(join(dir, ".env"), "GH_TOKEN=keep\nCUTOFF=17:00");
  const system = await Bun.file(join(dir, "system.json")).text();

  const { written } = await init(dir, answering({ "github.useGhToken": false, tz: "UTC", publish: "none" }));
  expect(written).not.toContain("system.json");
  expect(await Bun.file(join(dir, "system.json")).text()).toBe(system);
  const after = await Bun.file(join(dir, "project.json")).json();
  expect(after).toEqual({ id: "rocket", name: "Rocket", sources: { github: { repos: ["acme/rocket", "acme/ground"] } }, pipeline: { reels: { rounds: 2 } }, days: ["mon", "tue", "wed", "thu", "fri"], weekly: "thu" });
  expect(await Bun.file(join(dir, ".env")).text()).toBe("GH_TOKEN=keep\nCUTOFF=17:00\nDIGEST_TZ=UTC\nAGENT_MODEL=opus\n");
});

test("--yes refuses an answer that a question would refuse", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "init-")), "x");
  expect(init(dir, answering({ ...ANSWERS, "github.repos": "not-a-repo" }))).rejects.toThrow("each repo is owner/name");
  expect(init(dir, answering({ ...ANSWERS, cutoff: "6pm" }))).rejects.toThrow("HH:MM");
  expect(init(dir, answering({ ...ANSWERS, sources: "linear" }))).rejects.toThrow("linear is not one of github");
});

test("cron fires at the cutoff's UTC hour in winter and summer, on the issue days as UTC sees them", () => {
  expect(cron("Europe/Berlin", "18:30", ["mon", "tue", "wed", "thu", "fri"])).toBe("30 16,17 * * 1,2,3,4,5");
  expect(cron("UTC", "00:00")).toBe("0 0 * * *");
  expect(cron("America/Los_Angeles", "18:00", ["mon"])).toBe("0 1,2 * * 2");
});

test("without publishing, the daily workflow has no publish step and there is no publish workflow", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "init-")), "quiet");
  const { written } = await init(dir, answering({ ...ANSWERS, publish: "none" }));
  expect(written).not.toContain(".github/workflows/publish.yml");
  const daily = await Bun.file(join(dir, ".github", "workflows", "daily.yml")).text();
  expect(daily).not.toContain("publish --announce");
  expect(daily).toContain("Commit the issue");
});

test("init asks how many stories an issue may have: the default stays out of project.json, another is kept", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "init-")), "many");
  await init(dir, answering({ ...ANSWERS, stories: "9" }));
  const written = await Bun.file(join(dir, "project.json")).json();
  expect(written.pipeline).toEqual({ stories: { maxStories: 9 } });
  // Asked again, it offers what's there; the default takes it out and leaves the stage's other settings.
  await Bun.write(join(dir, "project.json"), JSON.stringify({ ...written, pipeline: { stories: { maxStories: 9, rounds: 2 } } }));
  await init(dir, answering({ ...ANSWERS, stories: undefined as never }));
  expect((await Bun.file(join(dir, "project.json")).json()).pipeline).toEqual({ stories: { maxStories: 9, rounds: 2 } });
  await init(dir, answering({ ...ANSWERS, stories: String(MAX_STORIES) }));
  expect((await Bun.file(join(dir, "project.json")).json()).pipeline).toEqual({ stories: { rounds: 2 } });
  expect(init(dir, answering({ ...ANSWERS, stories: String(STORIES_CEILING + 1) }))).rejects.toThrow(`a whole number from 1 to ${STORIES_CEILING}`);
});
