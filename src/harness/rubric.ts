import { join } from "node:path";
import { ENGINE, readJson } from "../issue";

// A reviewer grades work against its rubric: each criterion 1–5, and a round passes when every one meets its threshold.
// `examples` are graded pieces of work the reviewer sees with every input, so its scores stay where we set them.

export type Criterion = { id: string; describe: string; weight: number; threshold: number };
export type Rubric = { criteria: Criterion[]; examples: { work: unknown; scores: Record<string, number>; why: string }[] };
export type Review = { scores: Record<string, number>; notes: string[]; asks: { criterion: string; ask: string }[] };

export const loadRubric = (agent: string) => readJson<Rubric>(join(ENGINE, "agents", agent, "rubric.json"));

export function reviewSchema(rubric: Rubric): object {
  const ids = rubric.criteria.map((c) => c.id);
  return {
    type: "object", additionalProperties: false, required: ["scores", "notes", "asks"],
    properties: {
      scores: { type: "object", additionalProperties: false, required: ids, properties: Object.fromEntries(ids.map((id) => [id, { type: "integer", minimum: 1, maximum: 5 }])) },
      notes: { type: "array", maxItems: 9, items: { type: "string" } },
      asks: { type: "array", items: { type: "object", additionalProperties: false, required: ["criterion", "ask"], properties: { criterion: { enum: ids }, ask: { type: "string" } } } },
    },
  };
}

export const failing = (rubric: Rubric, review: Review) => rubric.criteria.filter((c) => (review.scores[c.id] ?? 0) < c.threshold);

// The weighted mean of the scores, 1–5: how rounds compare.
export function weighted(rubric: Rubric, review: Review) {
  const total = rubric.criteria.reduce((n, c) => n + c.weight, 0);
  return rubric.criteria.reduce((n, c) => n + c.weight * (review.scores[c.id] ?? 0), 0) / total;
}
