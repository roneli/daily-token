// Positions and timing for the pipeline reel. The template only places what this returns.
// Type is as large as the words allow (fit.ts), and the boxes and rows grow with it.

import { fit, SANS } from "./fit";

type Step = { name: string; sub: string };
type Event = { step: number; kind: "bad" | "good"; text: string; ref?: number | string };
type Metric = { label: string; before: string; after: string; ratio?: number; ref?: number | string };

const ARRIVE = 500;
const EVENT = 1100;
const METRIC = 900;
const TOP = 52;

export function layout(raw: Record<string, unknown>) {
  const steps = raw.steps as Step[];
  const events = (raw.events as Event[]) ?? [];
  const metrics = (raw.metrics as Metric[]) ?? [];
  const n = steps.length;
  const gap = 12;
  const w = (612 - gap * (n - 1)) / n;

  // One size for every box, set by the longest name and sub, so the boxes read as one row.
  const nameSize = fit(steps.map((s) => s.name), w - 14, 22, 14, SANS);
  const subSize = fit(steps.map((s) => s.sub), w - 14, 17, 11);
  const nameY = TOP + 8 + nameSize;
  // A line's box reaches about a third of its size below the baseline: the sub starts under the name's.
  const subY = nameY + Math.round(subSize + nameSize * 0.3 + 4);
  const h = subY - TOP + Math.round(subSize * 0.3) + 10;
  const midY = TOP + h / 2;
  const tokY = TOP + h + 18;

  const laidSteps = steps.map((s, i) => {
    const x = 14 + i * (w + gap);
    return { ...s, x, w, cx: x + w / 2, ax1: x + w, ax2: x + w + gap - 2 };
  });

  // An event line is its mark, its words and its ref; all lines share one size.
  const refText = (r?: number | string) => (r === undefined ? "" : `  #${r}`);
  const eventSize = fit(events.map((e) => `✕ ${e.text}${refText(e.ref)}`), 604, 18, 12.5);
  const line = Math.round(eventSize * 1.45);
  // A metric's label has the room before its value; the value has the rest of the line, or what the bar leaves.
  const metricSize = Math.min(
    fit(metrics.map((m) => m.label), 145, 17, 12.5),
    ...metrics.map((m) => fit([m.before, `${m.after}${refText(m.ref)}`], m.ratio ? 140 : 430, 17, 12.5)),
  );

  const moves: { at: number; x: number }[] = [];
  const boxCues: { step: number; at: number; cls: string }[] = [];
  const laidEvents: (Event & { at: number; y: number })[] = [];
  const eventsY = tokY + 22 + eventSize;
  let t = 300;
  let row = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      moves.push({ at: t, x: laidSteps[i].cx });
      t += ARRIVE;
    }
    boxCues.push({ step: i, at: t, cls: "on" });
    const mine = events.filter((e) => e.step === i);
    mine.forEach((e, k) => {
      const at = t + 150 + k * EVENT;
      laidEvents.push({ ...e, at, y: eventsY + row++ * line });
      boxCues.push({ step: i, at, cls: e.kind === "bad" ? "bad-on" : "good-on" });
    });
    t += mine.length ? 150 + mine.length * EVENT : 300;
  }

  const y0 = eventsY + row * line + 10 + metricSize;
  const laidMetrics = metrics.map((m, k) => ({ ...m, at: t + k * METRIC, y: y0 + k * Math.round(metricSize * 1.9), w: m.ratio ? 300 * m.ratio : 0 }));
  t += metrics.length * METRIC + 900;

  return {
    fields: { steps: laidSteps, events: laidEvents, metrics: laidMetrics, moves, boxCues, box: { y: TOP, h, nameY, subY, midY, nameSize, subSize }, tokY, eventSize, metricSize },
    ms: t,
  };
}
