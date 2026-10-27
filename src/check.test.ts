import { expect, test } from "bun:test";
import { join } from "node:path";
import { check } from "./check";
import { errorsOf, load } from "./harness/schema";
import { ENGINE, githubOf, loadIssue, STORIES_CEILING } from "./issue";

test("a weekly recap's themes cite the week's PRs, and nothing else", async () => {
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), "2026-01-15");
  const week = githubOf(issue.data).week;
  if (!week) throw new Error("the fixture's weekly issue has no week");
  // The week's PRs, as collect lists them from the archive: the 14th's.
  week.prs = [11, 12].map((n) => ({ ref: n, date: "2026-01-14", title: `PR ${n}`, parts: [], author: "dana", body: "" }));
  const recap = issue.stories.recap;
  if (!recap) throw new Error("the fixture's weekly issue has no recap");
  recap.themes = [
    { title: "Launch gets reliable", dek: "The spark retries.", refs: [11, 12] },
    { title: "Made up", dek: "Not in the week.", refs: [99] },
  ];
  const { errors } = await check(issue, "stories");
  expect(errors).toEqual(["recap theme 2 cites #99, which isn't one of the week's PRs (data.week.prs)"]);
  // Points or themes: a recap needs one or the other.
  recap.themes = undefined;
  recap.points = undefined;
  expect((await check(issue, "stories")).errors).toContain("the recap needs its themes");
});

test("an issue warns past its stories' cap and the week's and what's coming, and the cap has a ceiling", async () => {
  const issue = await loadIssue(join(ENGINE, "fixtures", "sample"), "2026-01-15");
  const many = (w: string[]) => w.filter((x) => x.includes("the day reads long"));
  // The fixture's four threads: the week, two stories and what's coming.
  expect(many((await check(issue)).warnings)).toEqual([]);
  issue.project.pipeline = { stories: { maxStories: 1 } };
  expect(many((await check(issue)).warnings)).toEqual(["4 threads; past 3 the day reads long, so fold small stories together"]);
  const schema = await load("project");
  for (const n of [1, STORIES_CEILING]) expect(errorsOf(schema, { ...issue.project, pipeline: { stories: { maxStories: n } } }, "project")).toEqual([]);
  for (const n of [0, STORIES_CEILING + 1, 2.5]) expect(errorsOf(schema, { ...issue.project, pipeline: { stories: { maxStories: n } } }, "project")).not.toEqual([]);
  expect((schema as { properties: { pipeline: { additionalProperties: { properties: { maxStories: { maximum: number } } } } } }).properties.pipeline.additionalProperties.properties.maxStories.maximum).toBe(STORIES_CEILING);
});
