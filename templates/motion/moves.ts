// The moves an opened part plays: each lays out its shapes in the card's own coordinates and writes its tracks, one
// beat per spoken sentence. The template draws the shapes; tour.js plays the tracks. Nothing here is drawn by an agent:
// a storyboard picks a move and fills its beats, or composes a free beat from these same primitives.

import type { Free, Move, MoveBeat, Stop, Tone } from "../../src/motion";

export type Shape =
  | { kind: "rect"; id?: string; cls: string; x: number; y: number; w: number; h: number; rx?: number; hidden?: boolean }
  | { kind: "circle"; id?: string; cls: string; cx: number; cy: number; r: number; hidden?: boolean }
  | { kind: "path"; id?: string; cls: string; d: string; length?: boolean; hidden?: boolean }
  | { kind: "text"; id?: string; cls: string; x: number; y: number; text: string; size: number; anchor?: "start" | "middle" | "end"; hidden?: boolean }
  | { kind: "g"; id: string; cls: string; hidden?: boolean; children: Shape[] };

export type Ease = "io" | "o" | "l";
export type MoveTrack =
  | { el: string; p: "o" | "ty" | "s" | "dash"; k: [number, number][]; e?: Ease }
  | { el: string; p: "along"; path: string; k: [number, number][]; e?: Ease }
  | { el: string; p: "pulse"; from: number; period: number; amp: number; to?: number };

// When each beat is said (ms), how long, and the card's life: open is when it has come up, end when it goes.
export type Clock = { at: (k: number) => number; len: (k: number) => number; open: number; end: number };
// A move's card: its size, its shapes, its tracks, the text sizes it uses, and where the camera goes in a beat.
export type Built = { w: number; h: number; shapes: Shape[]; tracks: MoveTrack[]; zoom?: { at: number; box: { x: number; y: number; w: number; h: number } }[]; clips?: string[] };

// Sizes in map units; the camera shows a card at about 1.2–1.4 times.
const HEAD = 84;
const PAD = 30;
const LABEL = 28;
const SMALL = 26;
// How faint a gate's way out is before it is said.
const FAINT = 0.35;
const CHAR = 0.56;
const textW = (t: string, size = LABEL) => t.length * size * CHAR;
const pillW = (t: string, size = LABEL) => Math.max(180, textW(t, size) + 52);

const toneCls = (t?: Tone) => t ?? "neutral";
// Appears at t: fades in and rises a little.
const appear = (id: string, t: number, dur = 300): MoveTrack[] => [
  { el: id, p: "o", k: [[t - 40, 0], [t + dur, 1]] },
  { el: id, p: "s", k: [[t - 40, 0.9], [t + dur + 100, 1]], e: "o" },
];
const lightAt = (id: string, t: number): MoveTrack => ({ el: id, p: "o", k: [[t - 40, 0], [t + 220, 1]] });
// A pulse that beats whole periods and then rests at its size: an idle element is still.
const pulse = (el: string, from: number, period: number, amp: number, until: number): MoveTrack => ({ el, p: "pulse", from, period, amp, to: from + Math.max(0, Math.floor((until - from) / period)) * period });
// A token's next stop along its path (v, a share of it), reached as beat time t is said: it sets off 450 ms before,
// never before it arrived at the last.
function tokenTo(tok: [number, number][], open: number, t: number, v: number) {
  const prev = tok.length ? tok[tok.length - 1] : ([open, 0] as [number, number]);
  tok.push([Math.max(prev[0], t - 450), prev[1]], [Math.max(prev[0], t), v]);
}

// A pill: a rounded box with a label, and its lit twin on top, which a track brings up.
function pill(id: string, x: number, cy: number, w: number, text: string, tone: Tone | undefined, size = LABEL): Shape[] {
  return [
    { kind: "rect", cls: "spill", x, y: cy - 26, w, h: 52, rx: 26 },
    { kind: "g", id: `${id}-lit`, cls: `lit ${toneCls(tone)}`, hidden: true, children: [{ kind: "rect", cls: "", x, y: cy - 26, w, h: 52, rx: 26 }] },
    { kind: "text", cls: "slabel", x: x + 22, y: cy + size * 0.36, text, size },
  ];
}

// steps: a sequence down a spine; a token runs it and a failure branches off its step in red.
function steps(id: string, beats: MoveBeat[], clock: Clock): Built {
  const ROW = 70;
  const main = Math.max(...beats.map((x) => pillW(x.label ?? "")));
  const branch = Math.max(0, ...beats.map((x) => (x.fail ? 70 + pillW(x.fail) : 0)));
  const spineX = PAD + 10;
  const pillX = PAD + 44;
  const shapes: Shape[] = [];
  const tracks: MoveTrack[] = [];
  let row = 0;
  const rowY = (r: number) => HEAD + r * ROW + ROW / 2;
  const rows = beats.map((b) => {
    const cy = rowY(row++);
    const failY = b.fail ? rowY(row++) : 0;
    return { b, cy, failY };
  });
  const first = rows[0].cy;
  const last = rows[rows.length - 1].cy;
  shapes.push({ kind: "path", cls: "spine", d: `M${spineX},${first} V${last}` });
  shapes.push({ kind: "path", id: `${id}-spinelit`, cls: "spinelit", d: `M${spineX},${first} V${last}`, length: true });
  shapes.push({ kind: "path", id: `${id}-spine`, cls: "route", d: `M${spineX},${first} V${last}` });
  const tok: [number, number][] = [];
  for (const [k, r] of rows.entries()) {
    const t = clock.at(k);
    if (r.b.fail) {
      const x = pillX + 70;
      shapes.push({ kind: "path", id: `${id}-fb${k}`, cls: "fbranch", d: `M${spineX},${r.cy} V${r.failY} H${x}`, hidden: true });
      shapes.push({ kind: "g", id: `${id}-fp${k}`, cls: "fpill t", hidden: true, children: [{ kind: "rect", cls: "", x, y: r.failY - 26, w: pillW(r.b.fail), h: 52, rx: 26 }, { kind: "text", cls: "", x: x + 22, y: r.failY + 10, text: r.b.fail, size: LABEL }] });
      const tf = t + clock.len(k) * 0.55;
      tracks.push({ el: `${id}-fb${k}`, p: "o", k: [[tf - 100, 0], [tf + 200, 1]] }, ...appear(`${id}-fp${k}`, tf + 100));
    }
    shapes.push({ kind: "circle", cls: "sdot", cx: spineX, cy: r.cy, r: 9 });
    shapes.push({ kind: "g", id: `${id}-s${k}`, cls: "step t", children: pill(`${id}-s${k}`, pillX, r.cy, main, r.b.label ?? "", r.b.tone) });
    tracks.push(lightAt(`${id}-s${k}-lit`, t), { el: `${id}-s${k}`, p: "s", k: [[t - 40, 1], [t + 160, 1.05], [t + 420, 1]] });
    tokenTo(tok, clock.open, t, (r.cy - first) / Math.max(1, last - first));
  }
  shapes.push({ kind: "circle", id: `${id}-tok`, cls: "tok", cx: 0, cy: 0, r: 13 });
  tracks.push({ el: `${id}-tok`, p: "along", path: `${id}-spine`, k: tok, e: "io" }, { el: `${id}-spinelit`, p: "dash", k: tok.map(([t, v]) => [t, 1 - v]), e: "io" });
  return { w: PAD + 44 + Math.max(main, branch) + PAD, h: HEAD + row * ROW + 16, shapes, tracks };
}

// fanout: one sender to many receivers; each beat sends to `count` more, a token to each.
function fanout(id: string, stop: Stop, beats: MoveBeat[], clock: Clock): Built {
  const COLS = 6;
  const GAP = 52;
  const total = beats.reduce((n, b) => n + Math.max(1, Math.min(12, b.count ?? 1)), 0);
  const rows = Math.ceil(total / COLS);
  const srcW = pillW(stop.source ?? "", LABEL);
  const gridX = PAD + srcW + 90;
  const gridY = HEAD + 30;
  const gridH = (rows - 1) * GAP;
  const srcY = gridY + gridH / 2;
  const legendY = gridY + gridH + 70;
  const legendW = Math.max(...beats.map((b) => textW(b.label ?? "", SMALL) + 60));
  const shapes: Shape[] = [...pill(`${id}-src`, PAD, srcY, srcW, stop.source ?? "", "neutral")];
  const tracks: MoveTrack[] = [lightAt(`${id}-src-lit`, clock.at(0) - 200)];
  let n = 0;
  for (const [k, b] of beats.entries()) {
    const t = clock.at(k);
    const count = Math.max(1, Math.min(12, b.count ?? 1));
    // The legend: a dot in this beat's colour and its words, lit as it is said. Each wave has its own colour, so
    // the first few stand out from the rest; a good or bad wave wears its tone.
    const ly = legendY + k * 44;
    shapes.push({ kind: "g", id: `${id}-lg${k}`, cls: `legend wave${k} ${toneCls(b.tone)}`, hidden: true, children: [{ kind: "circle", cls: "ldot", cx: PAD + 12, cy: ly - 8, r: 10 }, { kind: "text", cls: "ltext", x: PAD + 34, y: ly, text: b.label ?? "", size: SMALL }] });
    tracks.push(...appear(`${id}-lg${k}`, t));
    for (let j = 0; j < count; j++, n++) {
      const cx = gridX + (n % COLS) * GAP;
      const cy = gridY + Math.floor(n / COLS) * GAP;
      const route = `${id}-r${n}`;
      const lag = (j / Math.max(1, count)) * Math.min(900, clock.len(k) * 0.4);
      shapes.push({ kind: "circle", cls: "rdot", cx, cy, r: 15 });
      shapes.push({ kind: "circle", id: `${id}-d${n}`, cls: `rdot-lit wave${k} ${toneCls(b.tone)}`, cx, cy, r: 15, hidden: true });
      shapes.push({ kind: "path", id: route, cls: "route", d: `M${PAD + srcW},${srcY} C${PAD + srcW + 60},${srcY} ${cx - 60},${cy} ${cx},${cy}` });
      shapes.push({ kind: "circle", id: `${id}-t${n}`, cls: "tok small", cx: 0, cy: 0, r: 8, hidden: true });
      const go = t + lag;
      tracks.push({ el: `${id}-t${n}`, p: "along", path: route, k: [[go, 0], [go + 650, 1]], e: "io" });
      tracks.push({ el: `${id}-t${n}`, p: "o", k: [[go - 20, 0], [go + 40, 1], [go + 650, 1], [go + 750, 0]] });
      tracks.push(lightAt(`${id}-d${n}`, go + 650));
    }
  }
  const w = Math.max(gridX + (COLS - 1) * GAP + 15 + PAD, PAD + legendW + PAD);
  return { w, h: legendY + (beats.length - 1) * 44 + 30, shapes, tracks };
}

// cycle: its beats down a column, and a loop back from the last to the first that the token keeps running.
function cycle(id: string, stop: Stop, beats: MoveBeat[], clock: Clock): Built {
  const ROW = 70;
  const main = Math.max(...beats.map((x) => pillW(x.label ?? "")));
  const x0 = PAD + 44;
  const spineX = PAD + 10;
  const ys = beats.map((_, k) => HEAD + k * ROW + ROW / 2);
  const loopX = x0 + main + 40;
  const first = ys[0];
  const last = ys[ys.length - 1];
  // Down the spine, out to the right and back up to the top: one lap.
  const lap = `M${spineX},${first} V${last} H${loopX - 20} Q${loopX},${last} ${loopX},${last - 20} V${first + 20} Q${loopX},${first} ${loopX - 20},${first} H${spineX}`;
  const shapes: Shape[] = [
    { kind: "path", cls: "spine", d: lap },
    { kind: "path", id: `${id}-lap`, cls: "route", d: lap },
    { kind: "path", id: `${id}-laplit`, cls: "spinelit", d: lap, length: true },
  ];
  const tracks: MoveTrack[] = [];
  // Where each beat's row sits along the lap, as a share of its length.
  const len = 2 * (last - first) + 2 * (loopX - spineX);
  const frac = (y: number) => (y - first) / len;
  const tok: [number, number][] = [];
  for (const [k, b] of beats.entries()) {
    const t = clock.at(k);
    shapes.push({ kind: "circle", cls: "sdot", cx: spineX, cy: ys[k], r: 9 });
    shapes.push({ kind: "g", id: `${id}-s${k}`, cls: "step t", children: pill(`${id}-s${k}`, x0, ys[k], main, b.label ?? "", b.tone) });
    tracks.push(lightAt(`${id}-s${k}-lit`, t));
    tokenTo(tok, clock.open, t, frac(ys[k]));
  }
  // After the last beat it goes round again, `laps` times, and stops where it began.
  const laps = Math.max(1, Math.min(3, stop.laps ?? 2));
  let t = tok[tok.length - 1][0] + 300;
  const lapMs = Math.max(900, (clock.end - 600 - t) / laps);
  for (let l = 0; l < laps; l++) {
    tok.push([t, tok[tok.length - 1][1]], [t + lapMs * (1 - tok[tok.length - 1][1]), 1], [t + lapMs * (1 - tok[tok.length - 1][1]), 0]);
    t = tok[tok.length - 1][0];
  }
  shapes.push({ kind: "text", id: `${id}-again`, cls: "again", x: loopX + 16, y: (first + last) / 2 + 10, text: "again", size: SMALL, hidden: true });
  tracks.push(...appear(`${id}-again`, tok[2 * beats.length - 1][0] + 200));
  shapes.push({ kind: "circle", id: `${id}-tok`, cls: "tok", cx: 0, cy: 0, r: 13 });
  tracks.push({ el: `${id}-tok`, p: "along", path: `${id}-lap`, k: tok, e: "l" });
  tracks.push({ el: `${id}-laplit`, p: "dash", k: [[clock.open, 1], [clock.at(beats.length - 1) + 400, 1 - frac(last)], [t, 0]], e: "l" });
  return { w: loopX + 16 + textW("again", SMALL) + PAD, h: HEAD + beats.length * ROW + 16, shapes, tracks };
}

// layers: nested rings, drawn from the outside in by each beat's `ring`; each beat lights its ring as it is said and
// the camera goes to it.
function layers(id: string, beats: MoveBeat[], clock: Clock): Built {
  const STEP = 56;
  const SIZE = LABEL;
  const n = beats.length;
  const inner = { w: 240, h: 84 };
  // Outermost first, whatever order they are said in: by `ring`, else as given.
  const order = beats.map((b, k) => ({ b, k, ring: b.ring ?? k + 1 })).sort((a, b) => a.ring - b.ring);
  const longest = Math.max(...beats.map((b) => textW(b.label ?? "", SIZE)));
  const w = Math.max(inner.w + 2 * STEP * n, longest + 2 * STEP * (n - 1) + 70) + 2 * PAD;
  const h = HEAD + inner.h + 2 * STEP * n + 16;
  const shapes: Shape[] = [];
  const tracks: MoveTrack[] = [];
  const zoom: Built["zoom"] = [];
  const depth = new Map(order.map((o, j) => [o.k, j]));
  for (const [j, { b, k }] of order.entries()) {
    const x = PAD + j * STEP;
    const y = HEAD + j * STEP;
    const rw = w - 2 * PAD - 2 * j * STEP;
    const rh = h - HEAD - 16 - 2 * j * STEP;
    const t = clock.at(k);
    shapes.push({ kind: "rect", id: `${id}-ring${j}`, cls: `ring-layer ${toneCls(b.tone)}`, x, y, w: rw, h: rh, rx: 22, hidden: true });
    shapes.push({ kind: "text", id: `${id}-rl${j}`, cls: `ring-label ${toneCls(b.tone)}`, x: x + 20, y: y + 38, text: b.label ?? "", size: SIZE, hidden: true });
    tracks.push({ el: `${id}-ring${j}`, p: "o", k: [[t - 60, 0], [t + 300, 1]] });
    // A ring's label shows while the camera holds this ring or one outside it; once it goes further in, the label
    // would sit at the frame's edge, so it steps out, and comes back if the camera comes out again.
    const label: [number, number][] = [[t - 40, 0], [t + 300, 1]];
    for (const later of beats.map((_, m) => m).filter((m) => clock.at(m) > t)) {
      const at = clock.at(later);
      const v = (depth.get(later) ?? 0) > j ? 0 : 1;
      label.push([at, label[label.length - 1][1]], [at + 300, v]);
    }
    tracks.push({ el: `${id}-rl${j}`, p: "o", k: label });
    // The camera holds this ring, close.
    zoom.push({ at: t, box: { x: x - 14, y: y - 14, w: rw + 28, h: rh + 28 } });
  }
  zoom.sort((a, b) => a.at - b.at);
  // Every label the camera shows while it holds a ring (that ring's and the ones inside it) lies within the frame.
  const clips: string[] = [];
  for (const [j, z] of order.map((o, jj) => [jj, zoom.find((x) => x.at === clock.at(o.k))] as const)) {
    if (!z) continue;
    for (const [r, o] of order.entries()) {
      if (r < j) continue;
      const lx = PAD + r * STEP + 20;
      const ly = HEAD + r * STEP + 38;
      const inside = lx >= z.box.x && lx + textW(o.b.label ?? "", SIZE) <= z.box.x + z.box.w && ly - SIZE >= z.box.y && ly <= z.box.y + z.box.h;
      if (!inside) clips.push(`its layers cut "${o.b.label}" off at the frame's edge; shorten it`);
    }
  }
  // What the rings fence in, at the centre.
  const cx = w / 2;
  const cy = HEAD + STEP * n + inner.h / 2;
  shapes.push({ kind: "circle", id: `${id}-core`, cls: "tok", cx, cy, r: 16 });
  tracks.push(pulse(`${id}-core`, clock.open, 1400, 0.15, clock.end - 800));
  return { w, h, shapes, tracks, zoom, clips: [...new Set(clips)] };
}

// compare: the same moment two ways, a row a beat; the first side is how it goes wrong, the second how it goes right.
function compare(id: string, stop: Stop, beats: MoveBeat[], clock: Clock): Built {
  const [a, b] = stop.sides ?? ["Before", "After"];
  const colW = Math.max(240, ...beats.map((x) => Math.max(textW(x.label ?? "", SMALL), textW(x.other ?? "", SMALL)) + 40), textW(a, SMALL) + 20, textW(b, SMALL) + 20);
  const ROW = 64;
  const x1 = PAD;
  const x2 = PAD + colW + 24;
  const shapes: Shape[] = [
    { kind: "text", cls: "side bad", x: x1, y: HEAD + 26, text: a, size: SMALL },
    { kind: "text", cls: "side good", x: x2, y: HEAD + 26, text: b, size: SMALL },
    { kind: "path", cls: "divider", d: `M${x2 - 12},${HEAD} V${HEAD + 50 + beats.length * ROW}` },
  ];
  const tracks: MoveTrack[] = [];
  for (const [k, row] of beats.entries()) {
    const y = HEAD + 50 + k * ROW;
    const t = clock.at(k);
    shapes.push({ kind: "g", id: `${id}-a${k}`, cls: "cell bad", hidden: true, children: [{ kind: "rect", cls: "", x: x1, y, w: colW, h: 50, rx: 14 }, { kind: "text", cls: "", x: x1 + 18, y: y + 34, text: row.label ?? "", size: SMALL }] });
    shapes.push({ kind: "g", id: `${id}-b${k}`, cls: "cell good", hidden: true, children: [{ kind: "rect", cls: "", x: x2, y, w: colW, h: 50, rx: 14 }, { kind: "text", cls: "", x: x2 + 18, y: y + 34, text: row.other ?? "", size: SMALL }] });
    tracks.push(...appear(`${id}-a${k}`, t), ...appear(`${id}-b${k}`, t + Math.min(700, clock.len(k) * 0.4)));
  }
  return { w: x2 + colW + PAD, h: HEAD + 50 + beats.length * ROW + 20, shapes, tracks };
}

// gate: down a spine, a request meets a check (a bar across it); a bad beat turns it aside to its reason, in red, a
// good beat lets it through to the bottom, in green. Upright, so the card stays narrow and its words large.
function gate(id: string, stop: Stop, beats: MoveBeat[], clock: Clock): Built {
  const spineX = PAD + 20;
  const x0 = PAD + 50;
  const inX = x0 + 70;
  const req = beats.find((b) => (b.tone ?? "neutral") === "neutral");
  const bad = beats.filter((b) => b.tone === "bad");
  const good = beats.filter((b) => b.tone === "good");
  const w = Math.max(...[req, ...good].map((b) => pillW(b?.label ?? "Request")), ...bad.map((b) => 70 + pillW(b.label ?? "")), pillW(stop.check ?? "", SMALL) + 60);
  const y0 = HEAD + 40;
  const yBar = y0 + 96;
  const yRef = (k: number) => yBar + 76 + k * 64;
  const yPass = (k: number) => yRef(bad.length) + 16 + k * 64;
  const check = stop.check ?? "Check";
  const shapes: Shape[] = [
    { kind: "path", cls: "route-line", d: `M${spineX},${y0} V${yPass(good.length - 1)}` },
    { kind: "path", id: `${id}-in`, cls: "route", d: `M${spineX},${y0} V${yBar - 14}` },
    { kind: "circle", cls: "sdot", cx: spineX, cy: y0, r: 9 },
    ...pill(`${id}-req`, x0, y0, w, req?.label ?? "Request", "neutral"),
    { kind: "rect", id: `${id}-bar`, cls: "barrier t", x: spineX - 30, y: yBar - 7, w: 60, h: 14, rx: 7 },
    { kind: "text", cls: "check", x: spineX + 52, y: yBar + 9, text: check, size: SMALL },
  ];
  const tracks: MoveTrack[] = [];
  for (const [k, b] of bad.entries()) {
    shapes.push({ kind: "path", id: `${id}-back${k}`, cls: "route-line bad", d: `M${spineX},${yBar - 14} V${yRef(k)} H${inX}` });
    shapes.push({ kind: "g", id: `${id}-bad${k}`, cls: "cell bad t", hidden: true, children: [{ kind: "rect", cls: "", x: inX, y: yRef(k) - 26, w: pillW(b.label ?? ""), h: 52, rx: 26 }, { kind: "text", cls: "", x: inX + 22, y: yRef(k) + 10, text: b.label ?? "", size: LABEL }] });
  }
  for (const [k, b] of good.entries()) {
    shapes.push({ kind: "path", id: `${id}-pass${k}`, cls: "route", d: `M${spineX},${yBar - 14} V${yPass(k)}` });
    shapes.push({ kind: "circle", cls: "sdot", cx: spineX, cy: yPass(k), r: 9 });
    shapes.push({ kind: "g", id: `${id}-good${k}`, cls: "cell good t", hidden: true, children: [{ kind: "rect", cls: "", x: x0, y: yPass(k) - 26, w, h: 52, rx: 26 }, { kind: "text", cls: "", x: x0 + 22, y: yPass(k) + 10, text: b.label ?? "", size: LABEL }] });
  }
  let nb = 0;
  let ng = 0;
  for (const [k, b] of beats.entries()) {
    const t = clock.at(k);
    const tone = b.tone ?? "neutral";
    const tokId = `${id}-tok${k}`;
    shapes.push({ kind: "circle", id: tokId, cls: `tok ${tone}`, cx: 0, cy: 0, r: 13, hidden: true });
    if (tone === "neutral") {
      // The request comes down to the check and waits there while it looks.
      tracks.push(lightAt(`${id}-req-lit`, t), { el: tokId, p: "along", path: `${id}-in`, k: [[t + 200, 0], [t + 1000, 1]], e: "io" }, { el: tokId, p: "o", k: [[t + 150, 0], [t + 250, 1], [t + 1300, 1], [t + 1500, 0]] });
      tracks.push(pulse(`${id}-bar`, t + 1000, 900, 0.12, t + 1000 + 1800));
      continue;
    }
    const route = tone === "good" ? `${id}-pass${ng}` : `${id}-back${nb}`;
    const cell = tone === "good" ? `${id}-good${ng++}` : `${id}-bad${nb++}`;
    tracks.push({ el: tokId, p: "along", path: route, k: [[t, 0], [t + 900, 1]], e: "io" }, { el: tokId, p: "o", k: [[t - 20, 0], [t + 60, 1], [t + 900, 1], [t + 1100, 0]] });
    // Both ways out are there, faint, as soon as the card opens: the question is asked before it is answered.
    tracks.push({ el: cell, p: "o", k: [[clock.open, 0], [clock.open + 300, FAINT], [t + 700, FAINT], [t + 1000, 1]] }, { el: cell, p: "s", k: [[t + 700, 1], [t + 900, 1.06], [t + 1200, 1]], e: "o" });
    if (tone === "bad") tracks.push({ el: route, p: "o", k: [[clock.open, 0], [clock.open + 300, FAINT], [t - 60, FAINT], [t + 200, 1]] });
  }
  return { w: x0 + Math.max(w, ...bad.map((b) => 70 + pillW(b.label ?? ""))) + PAD, h: yPass(good.length - 1) + 44, shapes, tracks };
}

// free: the engine's primitives on a grid of slots (4 across, 4 down), each coming in on its beat.
const SLOT = { w: 210, h: 110, cols: 4, rows: 4 };
function free(id: string, f: Free, clock: Clock): Built {
  const shapes: Shape[] = [];
  const tracks: MoveTrack[] = [];
  const cx = (s: [number, number]) => PAD + s[0] * SLOT.w + SLOT.w / 2;
  const cy = (s: [number, number]) => HEAD + s[1] * SLOT.h + SLOT.h / 2;
  const when = (beat?: number) => clock.at(Math.max(0, beat ?? 0));
  const pos = new Map<string, { x: number; y: number; dot: boolean }>();
  for (const n of f.nodes) pos.set(n.id, { x: cx(n.at), y: cy(n.at), dot: n.shape === "dot" });
  const used = { cols: 1, rows: 1 };
  for (const n of [...f.nodes, ...(f.texts ?? [])]) {
    used.cols = Math.max(used.cols, n.at[0] + 1);
    used.rows = Math.max(used.rows, n.at[1] + 1);
  }
  for (const l of f.links ?? []) {
    const a = pos.get(l.from);
    const b = pos.get(l.to);
    if (!a || !b) continue;
    // From edge to edge of the two nodes, straight: the slots keep them apart.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    // How far from a node's centre its edge is, this way: a dot's radius, or where the line leaves its box.
    const reach = (dot: boolean) => (dot ? 18 : Math.min(Math.abs((SLOT.w / 2 - 10) / (dx / d || 1e-6)), Math.abs(30 / (dy / d || 1e-6))));
    const ra = reach(a.dot);
    const rb = reach(b.dot);
    const path = `M${a.x + (dx / d) * ra},${a.y + (dy / d) * ra} L${b.x - (dx / d) * rb},${b.y - (dy / d) * rb}`;
    shapes.push({ kind: "path", id: `${id}-${l.id}`, cls: `flink${l.dashed ? " dashed" : ""}`, d: path, length: true, hidden: true });
    tracks.push({ el: `${id}-${l.id}`, p: "o", k: [[when(l.beat) - 40, 0], [when(l.beat) + 200, 1]] });
    if (l.label) {
      shapes.push({ kind: "text", id: `${id}-${l.id}-label`, cls: "flabel", x: (a.x + b.x) / 2 + (dy === 0 ? 0 : 12), y: (a.y + b.y) / 2 + (dy === 0 ? -12 : 8), text: l.label, size: SMALL, anchor: dy === 0 ? "middle" : "start", hidden: true });
      tracks.push(...appear(`${id}-${l.id}-label`, when(l.beat) + 200));
    }
  }
  for (const n of f.nodes) {
    const p = pos.get(n.id) as { x: number; y: number; dot: boolean };
    const t = when(n.beat);
    const kids: Shape[] = n.shape === "dot"
      ? [{ kind: "circle", cls: `fdot ${toneCls(n.tone)}`, cx: p.x, cy: p.y, r: 16 }, ...(n.label ? [{ kind: "text" as const, cls: "flabel", x: p.x, y: p.y + 48, text: n.label, size: SMALL, anchor: "middle" as const }] : [])]
      : [{ kind: "rect", cls: `fbox ${toneCls(n.tone)}`, x: p.x - SLOT.w / 2 + 10, y: p.y - 30, w: SLOT.w - 20, h: 60, rx: 16 }, { kind: "text", cls: "flabel strong", x: p.x, y: p.y + 9, text: n.label ?? "", size: SMALL, anchor: "middle" }];
    shapes.push({ kind: "g", id: `${id}-${n.id}`, cls: "fnode t", hidden: true, children: kids });
    // How it comes in: as it is said, or on an effect's beat by zooming up from small, or by fading only.
    const zoom = f.effects?.find((e) => e.target === n.id && e.effect === "zoom");
    const fade = f.effects?.find((e) => e.target === n.id && e.effect === "fade");
    if (zoom) tracks.push({ el: `${id}-${n.id}`, p: "o", k: [[when(zoom.beat) - 40, 0], [when(zoom.beat) + 200, 1]] }, { el: `${id}-${n.id}`, p: "s", k: [[when(zoom.beat) - 40, 0.4], [when(zoom.beat) + 600, 1]], e: "o" });
    else if (fade) tracks.push({ el: `${id}-${n.id}`, p: "o", k: [[when(fade.beat) - 40, 0], [when(fade.beat) + 700, 1]] });
    else tracks.push(...appear(`${id}-${n.id}`, t));
  }
  for (const c of f.copies ?? []) {
    const p = pos.get(c.of);
    if (!p) continue;
    const t = when(c.beat);
    for (let j = 0; j < c.n; j++) {
      const [x, y] =
        c.arrange === "ring" ? [p.x + Math.cos((2 * Math.PI * j) / c.n) * 70, p.y + Math.sin((2 * Math.PI * j) / c.n) * 44]
        : c.arrange === "grid" ? [p.x - SLOT.w / 2 + 24 + (j % 5) * 40, p.y - 24 + Math.floor(j / 5) * 40]
        : [p.x - SLOT.w / 2 + 20 + j * 34, p.y + 50];
      shapes.push({ kind: "circle", id: `${id}-${c.id}-${j}`, cls: "fdot copy", cx: x, cy: y, r: 11, hidden: true });
      tracks.push({ el: `${id}-${c.id}-${j}`, p: "o", k: [[t + j * 60 - 40, 0], [t + j * 60 + 200, 1]] });
    }
  }
  for (const x of f.texts ?? []) {
    shapes.push({ kind: "text", id: `${id}-${x.id}`, cls: "ftext", x: cx(x.at), y: cy(x.at) + 9, text: x.text, size: SMALL, anchor: "middle", hidden: true });
    tracks.push(...appear(`${id}-${x.id}`, when(x.beat)));
  }
  for (const [j, k] of (f.tokens ?? []).entries()) {
    const route = `${id}-${k.along}`;
    const t = when(k.beat);
    const fromTo: [number, number][] = k.back ? [[t, 1], [t + 900, 0]] : [[t, 0], [t + 900, 1]];
    shapes.push({ kind: "circle", id: `${id}-ftok${j}`, cls: "tok", cx: 0, cy: 0, r: 12, hidden: true });
    tracks.push({ el: `${id}-ftok${j}`, p: "along", path: route, k: fromTo, e: "io" }, { el: `${id}-ftok${j}`, p: "o", k: [[t - 20, 0], [t + 60, 1], [t + 900, 1], [t + 1100, 0]] });
  }
  for (const [j, e] of (f.effects ?? []).entries()) {
    const el = `${id}-${e.target}`;
    const t = when(e.beat);
    if (e.effect === "pulse") tracks.push(pulse(el, t, 1000, 0.1, Math.min(t + 3000, clock.end - 800)));
    if (e.effect === "draw") tracks.push({ el, p: "dash", k: [[t, 1], [t + 700, 0]], e: "o" });
    if (e.effect === "orbit") {
      // A dot goes once round the target, as a ring of its own path.
      const p = pos.get(e.target);
      if (!p) continue;
      const ring = `M${p.x - 90},${p.y} a90,50 0 1,0 180,0 a90,50 0 1,0 -180,0`;
      shapes.push({ kind: "path", id: `${id}-orbit${j}`, cls: "route", d: ring });
      shapes.push({ kind: "circle", id: `${id}-orb${j}`, cls: "tok small", cx: 0, cy: 0, r: 8, hidden: true });
      // Once round, done before the card rests.
      const lap = Math.max(400, Math.min(1600, clock.end - 800 - t));
      tracks.push({ el: `${id}-orb${j}`, p: "along", path: `${id}-orbit${j}`, k: [[t, 0], [t + lap, 1]], e: "l" }, { el: `${id}-orb${j}`, p: "o", k: [[t - 20, 0], [t + 60, 1]] });
    }
  }
  return { w: PAD + used.cols * SLOT.w + PAD, h: HEAD + used.rows * SLOT.h + 50, shapes, tracks };
}

export function build(id: string, stop: Stop, move: Move, beats: MoveBeat[], clock: Clock): Built {
  if (move === "fanout") return fanout(id, stop, beats, clock);
  if (move === "cycle") return cycle(id, stop, beats, clock);
  if (move === "layers") return layers(id, beats, clock);
  if (move === "compare") return compare(id, stop, beats, clock);
  if (move === "gate") return gate(id, stop, beats, clock);
  if (move === "free" && stop.free) return free(id, stop.free, clock);
  return steps(id, beats, clock);
}

// The text each move draws, at its size: for the legibility gate.
export const textsOf = (shapes: Shape[]): { text: string; size: number }[] =>
  shapes.flatMap((s) => (s.kind === "text" ? [{ text: s.text, size: s.size }] : s.kind === "g" ? textsOf(s.children) : []));
