import { expect, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCtx } from "../harness/context";
import { scripted } from "../harness/model";
import { run } from "../harness/runner";
import { ENGINE, FORMAT, type Reels, type Stories, type Thread } from "../issue";
import { daily } from "../pipeline";
import { plan } from "./reels";

const DATE = "2026-01-15";
const grade = (ids: string[], n: number) => ({ scores: Object.fromEntries(ids.map((i) => [i, n])), notes: [], asks: n < 5 ? [{ criterion: ids[0], ask: "name the fix in plain words" }] : [] });
const EDITOR = ["true", "covered", "grouped", "plain", "tight"];
const READER = ["teammate", "newcomer", "partner", "honest", "legible", "arc", "tight"];

// A Director that answers each thread with the fixture's thread of that id; the input names the id to start with.
export const directorFrom = (threads: Thread[]) => (message: string) => {
  const t = threads.find((x) => message.includes(`"idPrefix": "${x.id}-"`));
  if (!t) throw new Error("no fixture thread for this input");
  return { name: t.name, shorts: t.shorts };
};

// The fixture day, made again from its own stories and reels; the browser gate is off, so no Chrome is needed.
test("the daily pipeline makes an issue from stories on, a thread per story, with every loop graded and traced", async () => {
  const root = await mkdtemp(join(tmpdir(), "stages-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const dir = join(root, "issues", DATE);
  const stories = await Bun.file(join(dir, "stories.json")).json() as Stories;
  const reels = await Bun.file(join(dir, "reels.json")).json() as Reels;
  const director = directorFrom(reels.threads);
  // On this Thursday the week comes first; the third thread, other, fails the Readers once and is revised; the others pass at once.
  const model = scripted({ writer: [stories, stories], editor: [grade(EDITOR, 3), grade(EDITOR, 5)], director: Array(5).fill(director), reader: [grade(READER, 5), grade(READER, 5), grade(READER, 3), grade(READER, 5), grade(READER, 5)] });

  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model, set: { reels: { gates: ["check"], parallel: 1, maxShorts: 5 } } });
  const { meta } = await run(ctx, daily, { from: "stories" });

  expect(model.sent.writer[1]).toContain("name the fix in plain words");
  expect(model.sent.director).toHaveLength(5);
  expect(model.sent.director[1]).toContain('"idPrefix": "launch-"');
  expect(model.sent.director[1]).not.toContain('"title": "Rename boosters to stages"');
  expect(meta.reviews).toEqual({
    stories: { stop: "passed", scores: [3, 5], costUsd: 0.04 },
    reels: { stop: "passed", score: 5, costUsd: 0.1, threads: { recap: { stop: "passed", scores: [5], costUsd: 0.02 }, launch: { stop: "passed", scores: [5], costUsd: 0.02 }, other: { stop: "passed", scores: [3, 5], costUsd: 0.04 }, next: { stop: "passed", scores: [5], costUsd: 0.02 } } },
  });
  expect((meta.check as { errors: string[] }).errors).toEqual([]);
  expect(await Bun.file(join(dir, "reels.json")).json()).toEqual(reels);
  expect(await Bun.file(join(dir, "trace", "stories", "2-editor.json")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "trace", "reels", "other", "2-reader.json")).exists()).toBe(true);
});

test("a short whose id doesn't start with its thread's goes back to the Director", async () => {
  const root = await mkdtemp(join(tmpdir(), "stages-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const reels = await Bun.file(join(root, "issues", DATE, "reels.json")).json() as Reels;
  const director = directorFrom(reels.threads);
  const wrong = (m: string) => {
    const t = director(m);
    return { ...t, shorts: t.shorts.map((s) => ({ ...s, id: s.id.replace(/^launch-/, "") })) };
  };
  const model = scripted({ director: [director, wrong, director, director, director] });
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model, set: { reels: { gates: ["check"], reviewers: [], parallel: 1, maxShorts: 5 } } });
  await run(ctx, daily, { from: "reels", to: "reels" });
  expect(model.sent.director[2]).toContain("starts with its thread");
});

test("a day where nothing landed stops before the Writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "stages-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const file = join(root, "issues", DATE, "data.json");
  const data = await Bun.file(file).json();
  await Bun.write(file, JSON.stringify({ ...data, sources: { github: { ...data.sources.github, prs: [], commits: [] } } }));
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model: scripted({}) });
  expect((await run(ctx, daily, { from: "stories" })).stopped).toBe("stories");
});

test("collect writes the current format: what every issue has, and each source's slice under sources", async () => {
  const { collectStage } = await import("./collect");
  const { SOURCES } = await import("../sources");
  const root = await mkdtemp(join(tmpdir(), "stages-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const github = SOURCES.find((s) => s.name === "github");
  if (!github) throw new Error("no github source");
  const real = github.collect;
  github.collect = async (_ctx, config) => ({ repo: (config as { repos: string[] }).repos[0], prs: [], tags: [], epics: [], openPrs: [], openPrCount: 0 });
  try {
    const ctx = await createCtx({ root, date: "2026-01-16", tz: "UTC", cutoff: "18:30", model: scripted({}) });
    await collectStage.run(ctx);
    const data = await ctx.read<Record<string, unknown>>("data.json");
    expect(data).toEqual({ format: FORMAT, engine: (await Bun.file(join(ENGINE, "package.json")).json()).version, edition: "daily", issue: 3, date: "2026-01-16", window: { from: "2026-01-15T18:30:00Z", to: "2026-01-16T18:30:00Z" }, sources: { github: { repo: "acme/rocket", prs: [], tags: [], epics: [], openPrs: [], openPrCount: 0 } } });

    // The weekly day is the project's: this Friday is weekly once project.json says so.
    const project = await Bun.file(join(root, "project.json")).json();
    await Bun.write(join(root, "project.json"), JSON.stringify({ ...project, weekly: "fri" }));
    const friday = await createCtx({ root, date: "2026-01-16", tz: "UTC", cutoff: "18:30", model: scripted({}) });
    await collectStage.run(friday);
    expect((await friday.read<{ edition: string }>("data.json")).edition).toBe("weekly");
  } finally {
    github.collect = real;
  }
});

test("a story gets about one short per two cards, the leftovers one", async () => {
  const dir = join(ENGINE, "fixtures", "sample", "issues", DATE);
  const [stories, data] = await Promise.all([Bun.file(join(dir, "stories.json")).json(), Bun.file(join(dir, "data.json")).json()]);
  expect(plan(stories, data).map((t) => [t.id, t.maxShorts])).toEqual([["recap", 2], ["launch", 2], ["other", 1], ["next", 2]]);
  expect(plan(stories, data, 5).every((t) => t.maxShorts === 5)).toBe(true);
});

test("the Writer and Editor see the stories' cap, and a digest past it goes back to the Writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "stages-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const stories = await Bun.file(join(root, "issues", DATE, "stories.json")).json() as Stories;
  const [first, ...rest] = stories.sections;
  const folded: Stories = { ...stories, sections: [{ ...first, cards: [first, ...rest].flatMap((s) => s.cards) }] };
  const model = scripted({ writer: [stories, folded], editor: [grade(EDITOR, 5)] });
  const ctx = await createCtx({ root, date: DATE, tz: "UTC", cutoff: "00:00", model, set: { stories: { maxStories: 1 } } });
  await run(ctx, daily, { from: "stories", to: "stories" });
  expect(model.sent.writer[0]).toContain('"maxStories": 1');
  expect(model.sent.writer[1]).toContain(`${stories.sections.length} stories; this issue gets at most 1`);
  expect(model.sent.editor[0]).toContain('"maxStories": 1');
  expect((await Bun.file(join(root, "issues", DATE, "stories.json")).json()).sections).toHaveLength(1);
});
