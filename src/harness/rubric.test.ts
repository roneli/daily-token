import { expect, test } from "bun:test";
import { failing, loadRubric, type Review, reviewSchema, weighted } from "./rubric";
import { errorsOf } from "./schema";

const rubric = { criteria: [{ id: "a", describe: "", weight: 3, threshold: 4 }, { id: "b", describe: "", weight: 1, threshold: 2 }], examples: [] };
const review = (a: number, b: number): Review => ({ scores: { a, b }, notes: [], asks: [] });

test("a round fails on any criterion under its threshold", () => {
  expect(failing(rubric, review(4, 2))).toEqual([]);
  expect(failing(rubric, review(3, 5)).map((c) => c.id)).toEqual(["a"]);
});

test("rounds compare by the weighted mean", () => {
  expect(weighted(rubric, review(5, 1))).toBe(4);
  expect(weighted(rubric, review(3, 5))).toBeLessThan(weighted(rubric, review(5, 1)));
});

test("the review schema needs a score for every criterion and asks that name one", () => {
  const schema = reviewSchema(rubric);
  expect(errorsOf(schema, review(4, 2))).toEqual([]);
  expect(errorsOf(schema, { scores: { a: 4 }, notes: [], asks: [] }).length).toBeGreaterThan(0);
  expect(errorsOf(schema, { ...review(4, 2), asks: [{ criterion: "c", ask: "x" }] }).length).toBeGreaterThan(0);
  expect(errorsOf(schema, review(6, 2)).length).toBeGreaterThan(0);
});

test("the engine's rubrics load and give a schema", async () => {
  for (const agent of ["editor", "reader"]) {
    const r = await loadRubric(agent);
    expect(r.criteria.every((c) => c.threshold >= 1 && c.threshold <= 5 && c.weight > 0)).toBe(true);
    expect(errorsOf(reviewSchema(r), { scores: Object.fromEntries(r.criteria.map((c) => [c.id, 5])), notes: [], asks: [] })).toEqual([]);
  }
});
