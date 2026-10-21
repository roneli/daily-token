import { expect, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "./check";
import { ENGINE, loadIssue, type Reels, shortsOf } from "./issue";
import { migrate, threadsV3 } from "./migrate";

// The fixture as format 1 had it: GitHub's fields at the top, cards citing pr, project repos, and flat reels that
// name their section (what's coming filed under "other"), with each section naming its first reel.
async function v1Root() {
  const root = await mkdtemp(join(tmpdir(), "migrate-"));
  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const project = await Bun.file(join(root, "project.json")).json();
  await Bun.write(join(root, "project.json"), JSON.stringify({ id: project.id, name: project.name, repos: project.sources.github.repos }));
  for (const d of ["2026-01-14", "2026-01-15"]) {
    const dir = join(root, "issues", d);
    const data = await Bun.file(join(dir, "data.json")).json();
    const { sources, format: _f, ...common } = data;
    await Bun.write(join(dir, "data.json"), JSON.stringify({ ...common, ...sources.github }));
    const reels = (await Bun.file(join(dir, "reels.json")).json()) as Reels;
    const flat = shortsOf(reels).map(({ thread, ...s }) => ({ ...s, section: thread === "next" ? "other" : thread }));
    const stories = await Bun.file(join(dir, "stories.json")).json();
    stories.sections = stories.sections.map((s: { id: string }) => ({ ...s, reel: flat.find((r) => r.section === s.id)?.id ?? null }));
    await Bun.write(join(dir, "stories.json"), JSON.stringify(stories).replaceAll('"ref":', '"pr":'));
    await Bun.write(join(dir, "reels.json"), JSON.stringify({ reels: flat }).replaceAll('"refs":', '"prs":').replaceAll('"ref":', '"pr":'));
  }
  return root;
}

test("migrate brings a format 1 root to format 3 with the same words, once", async () => {
  const root = await v1Root();
  expect(await migrate(root, { dryRun: true })).toHaveLength(7);
  expect((await Bun.file(join(root, "project.json")).json()).repos).toBeDefined();

  expect(await migrate(root)).toHaveLength(7);
  for (const d of ["2026-01-14", "2026-01-15"]) {
    const migrated = await loadIssue(root, d);
    expect(migrated.data.format).toBe(3);
    expect(await check(migrated)).toEqual({ errors: [], warnings: [] });
    for (const f of ["data.json", "stories.json"]) {
      const want = await Bun.file(join(ENGINE, "fixtures", "sample", "issues", d, f)).json();
      const got = await Bun.file(join(root, "issues", d, f)).json();
      if (f === "data.json") delete got.engine;
      expect(got).toEqual(want);
    }
    // Every short, word for word, in its section's thread and in the same order.
    const fixture = shortsOf(await Bun.file(join(ENGINE, "fixtures", "sample", "issues", d, "reels.json")).json());
    const ids = (await Bun.file(join(ENGINE, "fixtures", "sample", "issues", d, "reels.json")).json()).threads.map((t: { id: string }) => t.id);
    expect(migrated.reels.threads.map((t) => t.id)).toEqual(ids.filter((id: string) => id !== "next"));
    expect(shortsOf(migrated.reels).map(({ thread: _t, ...s }) => s)).toEqual(fixture.map(({ thread: _t, ...s }) => s));
  }
  expect(await Bun.file(join(root, "project.json")).json()).toEqual(await Bun.file(join(ENGINE, "fixtures", "sample", "project.json")).json());
  expect(await migrate(root)).toEqual([]);
});

test("a story that had no reel gets a title short in its own words", () => {
  const stories = { headline: "h", sections: [{ id: "fix", story: "quiet-fix", reel: null, title: "A quiet fix", dek: "Why it matters.", cards: [{ ref: 7 }, { ref: 8, with: [9] }] }] };
  const { stories: s, reels } = threadsV3(stories, { reels: [] });
  expect((s.sections as object[])[0]).not.toHaveProperty("reel");
  expect(reels).toEqual({ threads: [{ id: "fix", name: "quiet fix", shorts: [{ id: "fix-title", template: "title", seg: "quiet-fix", desk: "", epic: [], headline: "A quiet fix", caption: "Why it matters.", why: "", refs: [7, 8, 9], ms: 6000, fields: { title: "A quiet fix", dek: "Why it matters." } }] }] });
});
