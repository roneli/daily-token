// Positions and timing for the bars reel: stacked bars per day grow in turn, then milestones and a note.

type Series = { name: string; neutral?: boolean };
type Day = { label: string; values: number[]; today?: boolean };
type Milestone = { day: number; text: string };

const SLOTS = ["--s1", "--s2", "--s3", "--s4"];
const BASE = 312;
const TOP = 104;
const BW = 44;
const COL = 500;

export function layout(raw: Record<string, unknown>) {
  const series = raw.series as Series[];
  const days = raw.days as Day[];
  const milestones = (raw.milestones as Milestone[]) ?? [];
  let slot = 0;
  const laidSeries = series.map((s, k) => ({ ...s, color: s.neutral ? "--s0" : SLOTS[slot++ % SLOTS.length], lx: 20 + k * 150 }));

  const totals = days.map((d) => d.values.reduce((a, v) => a + v, 0));
  const max = Math.max(1, ...totals);
  const step = max <= 10 ? 2 : max <= 25 ? 5 : max <= 60 ? 10 : max <= 120 ? 20 : 50;
  const top = Math.ceil(max / step) * step;
  const px = (BASE - TOP) / top;
  const grid = [];
  for (let v = 0; v <= top; v += step) grid.push({ v, y: BASE - v * px });

  const pitch = Math.min(76, 540 / days.length);
  const x0 = 70 + (550 - pitch * days.length) / 2 + (pitch - BW) / 2;
  const laidDays = days.map((d, i) => {
    const x = x0 + i * pitch;
    let y0 = BASE;
    const segs = [];
    for (const [k, v] of d.values.entries()) {
      if (!v) continue;
      const h = v * px;
      segs.push({ y: y0 - h, h: Math.max(1, h - 2), color: laidSeries[k].color, tip: `${d.label} · ${series[k].name}: ${v}` });
      y0 -= h;
    }
    return { ...d, x, cx: x + BW / 2, total: totals[i], totalY: y0 - 6, segs, at: 300 + i * COL };
  });

  const laidMilestones = milestones.map((m, k) => {
    const d = laidDays[m.day];
    const y = 56 + (k % 2) * 16;
    const end = d.totalY - 14;
    return { ...m, x: d.cx, y, lineTo: end > y + 6 ? end : null, at: d.at + 500 };
  });
  const noteAt = laidDays[laidDays.length - 1].at + 900;
  const ms = Math.max(noteAt, ...laidMilestones.map((m) => m.at)) + 1200;
  return { fields: { ...raw, series: laidSeries, days: laidDays, grid, milestones: laidMilestones, noteAt, bw: BW, base: BASE }, ms };
}
