import type { Model, Run } from "./model";
import { failing, type Review, type Rubric, reviewSchema, weighted } from "./rubric";

// refine: the one loop every agent stage runs.
//   author ─▶ gates ─▶ reviewers ─▶ decide ─┐
//     ▲  gate errors: retried within the attempt        │
//     └──── feedback: failing criteria and asks ◀──────────┘
// Gates are code: cheap, run in order, and a gate runs only when the ones before it passed. What a gate saw
// (pictures, findings) is its evidence, which the reviewers get. Reviewers are other agents with rubrics.
// The loop stops when every criterion passes, the score stops rising, the rounds or the budget run out, or a
// revision fails. Every revision is reviewed, and the best-scoring round is the one kept.

export type Gate<T> = { name: string; run(value: T): Promise<{ errors: string[]; evidence?: unknown }> };
export type Evidence = Record<string, unknown>;
export type Reviewer<T> = { agent: string; rubric: Rubric; show(value: T, evidence: Evidence): { input: unknown; images?: string[] } };

export type Graded = { agent: string; review: Review; score: number; failing: string[] };
export type Round<T> = { n: number; value: T; evidence: Evidence; reviews: Graded[]; score: number | null; passed: boolean };
export type Stop = "passed" | "unreviewed" | "plateau" | "rounds" | "budget" | "failed";

export type Refine<T> = {
  model: Model;
  author: string;
  input: Record<string, unknown>;
  schema: object;
  gates?: Gate<T>[];
  reviewers?: Reviewer<T>[];
  // A value that needs no review, like an author declining the work: the loop stops on it, unreviewed.
  settled?: (value: T) => boolean;
  // Reviews at most: the first draft and up to rounds - 1 revisions.
  rounds: number;
  budgetUsd?: number;
  // Writes one file of the stage's trace: what each round made and how it was graded.
  trace?: (name: string, value: unknown) => Promise<unknown>;
  log?: (msg: string) => void;
};

export async function refine<T>(o: Refine<T>): Promise<{ value: T; evidence: Evidence; rounds: Round<T>[]; runs: Run[]; stop: Stop }> {
  const runs: Run[] = [];
  const rounds: Round<T>[] = [];
  const log = o.log ?? console.log;
  const spent = () => runs.reduce((n, r) => n + r.costUsd, 0);

  const make = async (input: unknown) => {
    let evidence: Evidence = {};
    const validate = async (value: T) => {
      evidence = {};
      for (const g of o.gates ?? []) {
        const { errors, evidence: seen } = await g.run(value);
        if (seen !== undefined) evidence[g.name] = seen;
        if (errors.length) return errors;
      }
      return [];
    };
    const { value, run } = await o.model.ask<T>(o.author, input, o.schema, { validate });
    runs.push(run);
    return { value, evidence };
  };

  await o.trace?.("input", o.input);
  let made = await make(o.input);
  for (let n = 1; ; n++) {
    const reviews: Graded[] = [];
    try {
      for (const r of o.settled?.(made.value) ? [] : (o.reviewers ?? [])) {
        const { input, images } = r.show(made.value, made.evidence);
        const { value: review, run } = await o.model.ask<Review>(r.agent, { rubric: r.rubric, work: input }, reviewSchema(r.rubric), { images });
        runs.push(run);
        reviews.push({ agent: r.agent, review, score: weighted(r.rubric, review), failing: failing(r.rubric, review).map((c) => c.id) });
      }
    } catch (e) {
      // A reviewer that fails leaves this draft ungraded: it is kept only when no round was graded.
      rounds.push({ n, ...made, reviews: [], score: null, passed: false });
      log(`review of round ${n} failed; keeping the best round so far: ${(e as Error).message.split("\n")[0]}`);
      return finish("failed");
    }
    const score = reviews.length ? reviews.reduce((s, g) => s + g.score, 0) / reviews.length : null;
    const round: Round<T> = { n, ...made, reviews, score, passed: reviews.every((g) => !g.failing.length) };
    rounds.push(round);
    await o.trace?.(`${n}-${o.author}`, { value: made.value, evidence: made.evidence, run: runs.filter((r) => r.agent === o.author).at(-1) });
    for (const g of reviews) await o.trace?.(`${n}-${g.agent}`, g);
    log(`round ${n}: ${score === null ? "not reviewed" : `score ${score.toFixed(2)}`}${reviews.some((g) => g.failing.length) ? `, failing ${reviews.flatMap((g) => g.failing).join(", ")}` : ""}`);

    const before = rounds.at(-2)?.score;
    const stop: Stop | null = !reviews.length ? "unreviewed"
      : round.passed ? "passed"
      : n >= o.rounds ? "rounds"
      : o.budgetUsd !== undefined && spent() >= o.budgetUsd ? "budget"
      : before != null && score !== null && score <= before ? "plateau"
      : null;
    if (stop) return finish(stop);

    const feedback = {
      failing: reviews.flatMap((g) => g.failing.map((id) => {
        const c = (o.reviewers ?? []).find((r) => r.agent === g.agent)?.rubric.criteria.find((x) => x.id === id);
        return { reviewer: g.agent, criterion: id, describe: c?.describe, score: g.review.scores[id], threshold: c?.threshold };
      })),
      asks: reviews.flatMap((g) => g.review.asks.map((a) => ({ reviewer: g.agent, ...a }))),
      notes: reviews.flatMap((g) => g.review.notes),
    };
    try {
      made = await make({ ...o.input, revise: { draft: made.value, feedback } });
    } catch (e) {
      log(`revision ${n + 1} failed; keeping the best round so far: ${(e as Error).message.split("\n")[0]}`);
      return finish("failed");
    }
  }

  function finish(stop: Stop) {
    // The best round: a passing one before a failing one, then the highest score, then the fewest failing
    // criteria, then the later one.
    const rank = (r: Round<T>) => [r.passed ? 1 : 0, r.score ?? 0, -r.reviews.reduce((n, g) => n + g.failing.length, 0)];
    const best = rounds.reduce((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      const i = y.findIndex((v, k) => v !== x[k]);
      return i === -1 || y[i] > x[i] ? b : a;
    });
    log(`stopped (${stop}) after ${rounds.length} rounds; kept round ${best.n}`);
    return { value: best.value, evidence: best.evidence, rounds, runs, stop };
  }
}
