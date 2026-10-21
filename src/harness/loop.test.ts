import { expect, test } from "bun:test";
import { type Gate, refine, type Reviewer } from "./loop";
import { scripted } from "./model";

type Draft = { v: number };
const schema = { type: "object", required: ["v"], properties: { v: { type: "number" } } };
const rubric = { criteria: [{ id: "good", describe: "good enough", weight: 1, threshold: 4 }], examples: [] };
const grade = (good: number, ask = "more") => ({ scores: { good }, notes: [], asks: good < 4 ? [{ criterion: "good", ask }] : [] });
const reviewer: Reviewer<Draft> = { agent: "critic", rubric, show: (value, evidence) => ({ input: { value, evidence } }) };
const quiet = () => {};

const run = (script: Record<string, unknown[]>, extra: Partial<Parameters<typeof refine<Draft>>[0]> = {}) => {
  const model = scripted(script);
  return { model, result: refine<Draft>({ model, author: "maker", input: { day: 1 }, schema, reviewers: [reviewer], rounds: 3, log: quiet, ...extra }) };
};

test("a first draft that passes is kept, after one review", async () => {
  const { result } = run({ maker: [{ v: 1 }], critic: [grade(5)] });
  const r = await result;
  expect(r.stop).toBe("passed");
  expect(r.value).toEqual({ v: 1 });
  expect(r.runs.map((x) => x.agent)).toEqual(["maker", "critic"]);
});

test("a revision gets its draft and the feedback, and is reviewed", async () => {
  const { model, result } = run({ maker: [{ v: 1 }, { v: 2 }], critic: [grade(3, "say why"), grade(5)] });
  const r = await result;
  expect(r.stop).toBe("passed");
  expect(r.value).toEqual({ v: 2 });
  expect(model.sent.maker[1]).toContain('"revise"');
  expect(model.sent.maker[1]).toContain('"draft"');
  expect(model.sent.maker[1]).toContain("say why");
  expect(model.sent.maker[1]).toContain('"threshold": 4');
  expect(model.sent.critic[0]).toContain("good enough");
});

test("the last revision is reviewed when the rounds run out, and the best round is kept", async () => {
  const { result } = run({ maker: [{ v: 1 }, { v: 2 }], critic: [grade(3), grade(2)] }, { rounds: 2 });
  const r = await result;
  expect(r.stop).toBe("rounds");
  expect(r.rounds.map((x) => x.score)).toEqual([3, 2]);
  expect(r.value).toEqual({ v: 1 });
});

test("of two rounds with one score, the one failing fewer criteria is kept", async () => {
  const three = { criteria: ["good", "clear", "tight"].map((id) => ({ id, describe: id, weight: 1, threshold: 4 })), examples: [] };
  const critic: Reviewer<Draft> = { ...reviewer, rubric: three };
  const review = (good: number, clear: number, tight: number) => ({ scores: { good, clear, tight }, notes: [], asks: [] });
  const model = scripted({ maker: [{ v: 1 }, { v: 2 }], critic: [review(5, 5, 1), review(3, 3, 5)] });
  const r = await refine<Draft>({ model, author: "maker", input: {}, schema, reviewers: [critic], rounds: 3, log: quiet });
  expect(r.stop).toBe("plateau");
  expect(r.rounds.map((x) => x.reviews[0].failing.length)).toEqual([1, 2]);
  expect(r.value).toEqual({ v: 1 });
});

test("a score that doesn't rise stops the loop", async () => {
  const { result } = run({ maker: [{ v: 1 }, { v: 2 }, { v: 3 }], critic: [grade(3), grade(3), grade(5)] }, { rounds: 5 });
  const r = await result;
  expect(r.stop).toBe("plateau");
  expect(r.rounds.length).toBe(2);
});

test("a spent budget stops the loop before a revision", async () => {
  const { result } = run({ maker: [{ v: 1 }], critic: [grade(2)] }, { budgetUsd: 0.01 });
  expect((await result).stop).toBe("budget");
});

test("a revision that fails keeps the best round so far", async () => {
  const { result } = run({ maker: [{ v: 1 }, new Error("cli down")], critic: [grade(3)] });
  const r = await result;
  expect(r.stop).toBe("failed");
  expect(r.value).toEqual({ v: 1 });
});

test("gates run in order, stop at the first that fails, and their evidence reaches the reviewer", async () => {
  const ran: string[] = [];
  const gates: Gate<Draft>[] = [
    { name: "even", run: async (d) => {
      ran.push("even");
      return { errors: d.v % 2 ? ["v must be even"] : [] };
    } },
    { name: "look", run: async (d) => {
      ran.push("look");
      return { errors: [], evidence: { shot: `v${d.v}.png` } };
    } },
  ];
  const { model, result } = run({ maker: [{ v: 1 }, { v: 2 }], critic: [grade(5)] }, { gates });
  const r = await result;
  expect(ran).toEqual(["even", "even", "look"]);
  expect(model.sent.maker[1]).toContain("v must be even");
  expect(r.evidence).toEqual({ look: { shot: "v2.png" } });
  expect(model.sent.critic[0]).toContain("v2.png");
});

test("with no reviewers the draft is kept as made", async () => {
  const { result } = run({ maker: [{ v: 7 }] }, { reviewers: [] });
  const r = await result;
  expect(r.stop).toBe("unreviewed");
  expect(r.value).toEqual({ v: 7 });
});

test("the trace has the input, each draft and each review", async () => {
  const files: string[] = [];
  const { result } = run({ maker: [{ v: 1 }, { v: 2 }], critic: [grade(3), grade(5)] }, { trace: async (name) => files.push(name) });
  await result;
  expect(files).toEqual(["input", "1-maker", "1-critic", "2-maker", "2-critic"]);
});

test("a passing round is kept over a higher-scoring one that fails a criterion", async () => {
  const two = { criteria: [{ id: "a", describe: "", weight: 1, threshold: 3 }, { id: "b", describe: "", weight: 1, threshold: 3 }], examples: [] };
  const critic: Reviewer<Draft> = { agent: "critic", rubric: two, show: (value) => ({ input: value }) };
  const g = (a: number, b: number) => ({ scores: { a, b }, notes: [], asks: [{ criterion: "b", ask: "more b" }] });
  const model = scripted({ maker: [{ v: 1 }, { v: 2 }], critic: [g(5, 2), g(3, 3)] });
  const r = await refine<Draft>({ model, author: "maker", input: {}, schema, reviewers: [critic], rounds: 3, log: quiet });
  expect(r.stop).toBe("passed");
  expect(r.value).toEqual({ v: 2 });
});

test("a reviewer that fails keeps the best graded round", async () => {
  const { result } = run({ maker: [{ v: 1 }, { v: 2 }], critic: [grade(3), new Error("cli down")] });
  const r = await result;
  expect(r.stop).toBe("failed");
  expect(r.value).toEqual({ v: 1 });
});

test("a reviewer that fails on the first draft keeps that draft", async () => {
  const { result } = run({ maker: [{ v: 1 }], critic: [new Error("cli down")] });
  const r = await result;
  expect(r.stop).toBe("failed");
  expect(r.value).toEqual({ v: 1 });
});
