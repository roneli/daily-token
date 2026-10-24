import { expect, test } from "bun:test";
import { join } from "node:path";
import { check } from "./check";
import { ENGINE, githubOf, loadIssue } from "./issue";

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
