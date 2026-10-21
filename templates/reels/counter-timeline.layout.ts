// Positions and timing for the counter-timeline reel: counters count up, then tags drop onto a time axis.

type Counter = { value: number; label: string; prefix?: string; suffix?: string; minus?: number };

const CW = 7.2; // advance of the 12px mono face on the label line
type Tag = { name: string; at: string; kind?: number };
type Axis = { from: string; to: string };

const SLOTS = ["--s1", "--s2", "--s3", "--s4"];
const X0 = 40;
const X1 = 600;

export function layout(raw: Record<string, unknown>) {
  const counters = (raw.counters as Counter[]) ?? [];
  const tags = (raw.tags as Tag[]) ?? [];
  const axis = raw.axis as Axis;
  const from = Date.parse(axis.from);
  const to = Date.parse(axis.to);
  const x = (t: number) => X0 + ((t - from) / (to - from)) * (X1 - X0);

  const laidCounters = counters.map((c, i) => {
    const display = `${c.prefix ?? ""}${c.value.toLocaleString("en-US")}${c.suffix ?? ""}`;
    // The minus heads the label line, where the face is mono and widths are exact.
    const minus = c.minus === undefined ? "" : `−${c.minus.toLocaleString("en-US")}`;
    return { ...c, x: X0 + i * 200, display, minusText: minus, labelX: X0 + i * 200 + (minus ? minus.length * CW + 6 : 0) };
  });

  const ticks: { x: number; label: string }[] = [];
  const hour = 3_600_000;
  const span = to - from;
  const step = span > 12 * hour ? 3 * hour : span > 6 * hour ? 2 * hour : hour;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    ticks.push({ x: x(t), label: `${new Date(t).toISOString().slice(11, 16)}Z` });
  }

  let t = 1500;
  const laidTags = tags.map((g, i) => {
    const tx = x(Date.parse(g.at));
    const end = tx > 440;
    const row = i % 3;
    const at = t;
    t += 500;
    return { ...g, x: tx, y: 200 - row * 22, lx: end ? tx - 4 : tx + 4, anchor: end ? "end" : "start", color: SLOTS[(g.kind ?? 0) % SLOTS.length], at };
  });
  const noteAt = Math.max(t, 1500) + 300;
  return { fields: { ...raw, counters: laidCounters, ticks, tags: laidTags, noteAt }, ms: noteAt + 1200 };
}
