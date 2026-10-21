// Positions and timing for the pipeline reel. The template only places what this returns.

type Step = { name: string; sub: string };
type Event = { step: number; kind: "bad" | "good"; text: string; ref?: number | string };
type Metric = { label: string; before: string; after: string; ratio?: number; ref?: number | string };

const ARRIVE = 500;
const EVENT = 1100;
const METRIC = 900;
const LINE = 22;

export function layout(raw: Record<string, unknown>) {
  const steps = raw.steps as Step[];
  const events = (raw.events as Event[]) ?? [];
  const metrics = (raw.metrics as Metric[]) ?? [];
  const n = steps.length;
  const gap = 12;
  const w = (612 - gap * (n - 1)) / n;

  const laidSteps = steps.map((s, i) => {
    const x = 14 + i * (w + gap);
    return { ...s, x, w, cx: x + w / 2, ax1: x + w, ax2: x + w + gap - 2 };
  });

  const moves: { at: number; x: number }[] = [];
  const boxCues: { step: number; at: number; cls: string }[] = [];
  const laidEvents: (Event & { at: number; y: number })[] = [];
  let t = 300;
  let line = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      moves.push({ at: t, x: laidSteps[i].cx });
      t += ARRIVE;
    }
    boxCues.push({ step: i, at: t, cls: "on" });
    const mine = events.filter((e) => e.step === i);
    mine.forEach((e, k) => {
      const at = t + 150 + k * EVENT;
      laidEvents.push({ ...e, at, y: 170 + line++ * LINE });
      boxCues.push({ step: i, at, cls: e.kind === "bad" ? "bad-on" : "good-on" });
    });
    t += mine.length ? 150 + mine.length * EVENT : 300;
  }

  const y0 = 170 + line * LINE + 18;
  const laidMetrics = metrics.map((m, k) => ({ ...m, at: t + k * METRIC, y: y0 + k * 30, w: m.ratio ? 300 * m.ratio : 0 }));
  t += metrics.length * METRIC + 900;

  return { fields: { steps: laidSteps, events: laidEvents, metrics: laidMetrics, moves, boxCues }, ms: t };
}
