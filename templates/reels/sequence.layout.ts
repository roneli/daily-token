// Positions and timing for the sequence reel. The template only places what this returns.

type Tone = "ink" | "secret" | "bad" | "good";
type Mark = { text: string; tone: "bad" | "good" };
type Msg = {
  from: number;
  to: number;
  label: string;
  label2?: string;
  tone: Tone;
  label2Tone?: Tone;
  tag?: string;
  struck?: boolean;
  same?: boolean;
  result?: Mark;
  flash?: { actor: number; tone: "bad" | "good" };
};

const CW = 7.2; // advance of the 12px mono face
const LINE = 15; // line pitch of the 12px face
const TOP = 62; // below the actor boxes
const BOTTOM = 322; // above the note
const SEND = 600;
const STEP = 1100;
const STRIKE = 800;
const XS: Record<number, number[]> = { 2: [120, 520], 3: [80, 320, 560] };

// Wrap to `max` characters on at most two lines, split where the longer line is shortest, so no word is left alone.
export function wrap(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const words = text.split(" ");
  let best = [text];
  let longest = Number.POSITIVE_INFINITY;
  for (let k = 1; k < words.length; k++) {
    const lines = [words.slice(0, k).join(" "), words.slice(k).join(" ")];
    const l = Math.max(...lines.map((x) => x.length));
    if (l < longest) [best, longest] = [lines, l];
  }
  return best;
}

// A result sits past the arrowhead, on the side away from the arrow; with no room there, under the arrow's end.
function resultAt(x1: number, x2: number, y: number, text: string) {
  const w = text.length * CW;
  if (x2 > x1 && x2 + 12 + w <= 632) return { x: x2 + 12, y: y + 4, anchor: "start", below: false };
  if (x2 < x1 && x2 - 12 - w >= 8) return { x: x2 - 12, y: y + 4, anchor: "end", below: false };
  // Under the arrow itself, clear of the lifeline it points at.
  return x2 > x1 ? { x: x2 - 10, y: y + 18, anchor: "end", below: true } : { x: x2 + 10, y: y + 18, anchor: "start", below: true };
}

export function layout(raw: Record<string, unknown>) {
  const actors = raw.actors as { name: string }[];
  const msgs = raw.messages as Msg[];
  const X = XS[actors.length];
  if (!X) throw new Error(`sequence: ${actors.length} actors; 2 or 3 fit`);
  for (const m of msgs) {
    if (m.from === m.to || !(m.from in X) || !(m.to in X)) throw new Error(`sequence: message "${m.label}" goes from ${m.from} to ${m.to}`);
    if (m.flash && !(m.flash.actor in X)) throw new Error(`sequence: message "${m.label}" flashes actor ${m.flash.actor}`);
  }

  // Each message's text block: label lines then label2 lines, wrapped to the gap between its two lifelines.
  const blocks = msgs.map((m) => {
    const max = Math.max(10, Math.floor((Math.abs(X[m.to] - X[m.from]) - 24) / CW));
    const label = wrap(m.label, max).map((text) => ({ text, tone: m.tone as string, struck: !!m.struck }));
    const label2 = m.label2 ? wrap(m.label2, max).map((text) => ({ text, tone: m.label2Tone ?? "", struck: false })) : [];
    // A tag ("before", "now") heads the block, so it never sits on another arrow.
    const tag = m.tag ? [{ text: m.tag, tone: m.tone as string, struck: false }] : [];
    return [...tag, ...label, ...label2];
  });
  // Rows grow to what they hold: text above the arrow, a result below it.
  const rowOf: number[] = [];
  for (const [i, m] of msgs.entries()) rowOf.push(i === 0 || !m.same ? (rowOf.at(-1) ?? -1) + 1 : (rowOf.at(-1) as number));
  const rowCount = (rowOf.at(-1) ?? 0) + 1;
  const above = Array.from({ length: rowCount }, (_, r) => Math.max(...msgs.map((_, i) => (rowOf[i] === r ? blocks[i].length * LINE + 6 : 0))));
  const below = Array.from({ length: rowCount }, (_, r) =>
    Math.max(8, ...msgs.map((m, i) => (rowOf[i] === r && m.result && resultAt(X[m.from], X[m.to], 0, m.result.text).below ? 24 : 8))),
  );
  const need = above.reduce((a, b) => a + b, 0) + below.reduce((a, b) => a + b, 0);
  if (TOP + need > BOTTOM) throw new Error(`sequence: the messages need ${need} px of height and ${BOTTOM - TOP} fit; shorten labels or use fewer rows`);
  const slack = Math.min(28, (BOTTOM - TOP - need) / rowCount);
  const rowY: number[] = [];
  let cursor = TOP;
  for (let r = 0; r < rowCount; r++) {
    rowY.push(cursor + above[r] + slack / 2);
    cursor = rowY[r] + below[r] + slack / 2;
  }
  const laidActors = actors.map((a, i) => ({ ...a, cx: X[i], x: X[i] - 50 }));

  const moves: { at: number; ms: number; x: number; y: number }[] = [];
  const cues: { el: string; kind: string; at: number; to?: string }[] = [];
  let flashed = new Set<number>();
  let row = -1;
  let t = 300;
  cues.push({ el: "tok", kind: "fade", at: t });

  const laid = msgs.map((m, i) => {
    if (i === 0 || !m.same) row++;
    const y = Math.round(rowY[row]);
    const x1 = X[m.from];
    const x2 = X[m.to];
    const mid = (x1 + x2) / 2;
    const lines = blocks[i].map((l, k) => ({ ...l, y: y - 8 - (blocks[i].length - 1 - k) * LINE }));
    if (!m.same) for (const a of flashed) cues.push({ el: `a${a}`, kind: "class", at: t, to: "" });
    if (!m.same) flashed = new Set();
    moves.push({ at: t, ms: 1, x: x1, y }, { at: t + 20, ms: SEND, x: x2, y });
    const out = {
      ...m,
      i,
      y,
      x1,
      x2: x2 + (x2 > x1 ? -6 : 6),
      mid,
      lines,
      at: t + 450,
      markAt: t + 620,
      resultPos: m.result ? resultAt(x1, x2, y, m.result.text) : null,
      strikes: [] as { x1: number; x2: number; y1: number; y2: number; at: number }[],
    };
    if (m.flash) {
      cues.push({ el: `a${m.flash.actor}`, kind: "class", at: t + 620, to: m.flash.tone === "bad" ? "bad-on" : "good-on" });
      flashed.add(m.flash.actor);
    }
    t += STEP;
    if (m.struck) {
      // An ✗ across the arrow: a line through the words made them hard to read.
      out.strikes = [
        { x1: mid - 7, x2: mid + 7, y1: y - 7, y2: y + 7, at: t + 300 },
        { x1: mid - 7, x2: mid + 7, y1: y + 7, y2: y - 7, at: t + 450 },
      ];
      t += STRIKE;
    }
    return out;
  });

  cues.push({ el: "tok", kind: "out", at: t });
  const noteAt = t + 300;
  return {
    fields: { actors: laidActors, messages: laid, note: raw.note ?? "", noteAt, tok: { x: X[msgs[0].from], y: Math.round(rowY[0]) }, moves, cues },
    ms: Math.round(noteAt + 900),
  };
}
