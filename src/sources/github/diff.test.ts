import { expect, test } from "bun:test";
import { diffBudget, diffOf } from "./diff";

test("a diff keeps code before tests and docs, leaves out lockfiles and generated files, and fits its budget", () => {
  const patch = (n: number) => `@@ -1 +1 @@\n${"+line\n".repeat(n)}`;
  const files = [
    { filename: "README.md", patch: patch(3) },
    { filename: "engine/ignite.test.ts", patch: patch(3) },
    { filename: "bun.lock", patch: patch(3) },
    { filename: "engine/gen/api.ts", patch: patch(3) },
    { filename: "engine/ignite.ts", patch: patch(3) },
    { filename: "logo.png" },
  ];
  const d = diffOf(files, 4000);
  expect([...d.matchAll(/^--- (.+)$/gm)].map((m) => m[1])).toEqual(["engine/ignite.ts", "engine/ignite.test.ts", "README.md"]);
  expect(diffOf([{ filename: "engine/ignite.ts", patch: patch(2000) }], 1000).length).toBeLessThanOrEqual(1000);
});

test("a busy day gives each change less of the diff, within a floor and a ceiling", () => {
  expect(diffBudget(5)).toBe(4000);
  expect(diffBudget(30)).toBe(2000);
  expect(diffBudget(500)).toBe(600);
});
