// Positions and timing for the stack reel: progress bars fill, queued items drop into a grid, then a card.

type Bar = { label: string; done: number; total: number };
type Queue = { count?: number; items?: string[]; label: string; sub?: string };
type Card = { title: string; lines: string[] };

const BAR_W = 300;
const PER_ROW = 7;

export function layout(raw: Record<string, unknown>) {
  const bars = (raw.bars as Bar[]) ?? [];
  const queue = raw.queue as Queue | undefined;
  const card = raw.card as Card | undefined;

  const laidBars = bars.map((b, i) => ({ ...b, y: 76 + i * 46, w: b.total ? (BAR_W * Math.min(b.done, b.total)) / b.total : 0, at: 300 + i * 150 }));
  let t = laidBars.length ? laidBars[laidBars.length - 1].at + 900 : 300;

  // Named items get wider boxes with their name in them; a bare count gets narrow empty ones.
  const items = queue?.items ?? [];
  const [perRow, w] = items.length ? [6, 38] : [PER_ROW, 30];
  const boxes = [];
  for (let i = 0; i < (items.length || queue?.count || 0); i++) {
    const x = 370 + (i % perRow) * (w + 4 + (items.length ? 0 : 2));
    boxes.push({ x, y: 60 + Math.floor(i / perRow) * 50, w, cx: x + w / 2, name: items[i] ?? "", at: t + i * 110 });
  }
  if (boxes.length) t = boxes[boxes.length - 1].at + 300;
  const queueAt = t;
  if (queue) t += 500;
  const cardAt = card ? t + 300 : t;
  return { fields: { ...raw, bars: laidBars, boxes, queueAt, cardAt, barW: BAR_W }, ms: cardAt + 1500 };
}
