import { describe, expect, test } from "bun:test";
import { closingRefs, coauthors, epicPath, partOf, partsOf, weekOf } from "./collect";
import { commitRef, type GithubDay } from "../../issue";
import type { System } from "../../issue";

test("coauthors come from trailers, once each, without the author", () => {
  const msgs = ["Fix it\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", "More\n\nco-authored-by: Dana <d@x.test>\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>", "Co-authored-by: Sam <s@x.test>"];
  expect(coauthors(msgs, "Sam")).toEqual(["Claude Opus 5.5", "Dana"]);
});

test("a commit's closing keywords are GitHub's", () => {
  expect(closingRefs("Fix the pad\n\nFixes #12, closes #3 and Resolved: #4. Not #5, not prefix#6")).toEqual([12, 3, 4]);
});

test("a direct commit is cited by short hash, by name@ in another repo", () => {
  expect(commitRef("acme/rocket", "abc1234def", "acme/rocket")).toBe("abc1234");
  expect(commitRef("acme/ground", "abc1234def", "acme/rocket")).toBe("ground@abc1234");
});

test("part of #N is read from the body", () => {
  expect(partOf("Part of #98.\nAlso part of #12, not #13")).toEqual([98, 12]);
});

test("files map to parts by glob; the rest is unmatched", () => {
  const system = { parts: [{ id: "api", paths: ["services/api/**"], core: true }, { id: "web", paths: ["apps/web/**", "packages/ui/**"] }, { id: "docs" }] } as unknown as System;
  expect(partsOf(["services/api/main.go", "apps/web/a.tsx", "README.md"], system)).toEqual({ parts: ["api", "web"], core: true, unmatched: ["README.md"] });
  expect(partsOf(["apps/web/a.tsx"], system).core).toBe(false);
  expect(partsOf(["README.md", "docs/a.md"], { ...system, ignore: ["*.md", "docs/**"] }).unmatched).toEqual([]);
  const two = { parts: [{ id: "api", paths: ["services/api/**"] }, { id: "runner", paths: ["runners:images/**"] }] } as unknown as System;
  expect(partsOf(["images/a", "services/api/b"], two, "runners:")).toEqual({ parts: ["runner"], core: false, unmatched: ["runners:services/api/b"] });
});

describe("epicPath", () => {
  const at = (repo: string) => ({ repository: { nameWithOwner: repo } });
  const root = { ...at("acme/plans"), number: 7, title: "root", subIssuesSummary: { total: 9, completed: 4 }, parent: null };
  const leaf = { ...at("acme/rocket"), number: 455, title: "leaf", subIssuesSummary: { total: 0, completed: 0 }, parent: { ...at("acme/rocket"), number: 100, title: "mid", subIssuesSummary: { total: 3, completed: 1 }, parent: root } };
  const graph = new Map([[455, leaf]]);

  test("a closed issue's ancestors, root first, other repos by name", () => {
    expect(epicPath(455, graph, false, "acme/rocket")).toEqual(["plans#7", 100]);
  });

  test("a part-of issue includes itself", () => {
    expect(epicPath(455, graph, true, "acme/rocket")).toEqual(["plans#7", 100, 455]);
  });

  test("no chain means no epic", () => {
    expect(epicPath(8, graph, false, "acme/rocket")).toEqual([]);
  });
});

describe("weekOf", () => {
  const day = (prs: number[][], closed: number, extra: Partial<GithubDay> = {}) =>
    ({ prs: prs.map((path, i) => ({ number: i, epicPath: path })), commits: [], tags: [], issues: [], epics: [{ number: 7, title: "Reach orbit", closed, total: 5 }], ...extra }) as unknown as GithubDay;

  test("counts Friday to Thursday from the archive and today", () => {
    const earlier = [
      { date: "2026-01-08", headline: "last Thursday", data: day([[7]], 0) },
      { date: "2026-01-09", headline: "Friday", data: day([[7], []], 1) },
      { date: "2026-01-13", headline: "Tuesday", data: day([[7]], 2, { tags: [{ name: "v1", at: "", sha: "" }] }) },
    ];
    const w = weekOf("2026-01-15", earlier, day([[7], [7], []], 4), "acme/rocket");
    expect(w.from).toBe("2026-01-09");
    expect(w.days.map((d) => d.date)).toEqual(["2026-01-09", "2026-01-13", "2026-01-15"]);
    expect(w.days[2].epics).toEqual({ "7": 2, none: 1 });
    expect(w.totals).toEqual({ prs: 6, commits: 0, issuesClosed: 0, tags: 1 });
    expect(w.epics).toEqual([{ ref: 7, title: "Reach orbit", closed: 4, total: 5, closedThisWeek: 3 }]);
  });

  test("progress is unknown without an earlier issue to compare with", () => {
    expect(weekOf("2026-01-15", [], day([[7]], 4), "acme/rocket").epics[0].closedThisWeek).toBeNull();
  });

  test("a day collected again after the fact is counted but isn't a starting point", () => {
    const w = weekOf("2026-01-15", [{ date: "2026-01-13", headline: "", data: day([[7]], 4), refetched: true }], day([[7]], 4), "acme/rocket");
    expect(w.totals.prs).toBe(2);
    expect(w.epics[0].closedThisWeek).toBeNull();
  });
});
