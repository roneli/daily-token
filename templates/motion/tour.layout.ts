// The Cutaway's map, camera and timing. The template only places what this returns; tour.js only plays the
// tracks: each a list of [ms, value] keyframes for one property of one element.

import { type Ref, refLabel, type System } from "../../src/issue";
import { layout, type MapPart, meaningOf, type Measure } from "../../src/layout";
import { groupsOf, INSIDE, type Look, moveOf, spoken, type Storyboard, type Timeline } from "../../src/motion";
import { build, type Clock, type Ease, type MoveTrack, textsOf } from "./moves";

type Box = { x: number; y: number; w: number; h: number };
type Cam = [x: number, y: number, s: number];
// A move's tracks, and the camera's: where it looks and how near, in log space between keyframes (tour.js).
export type Track = MoveTrack | { el: string; p: "cam"; k: [number, number, number, number][]; e?: Ease };

// The video is 1080×1350; the map plays between the masthead and the captions.
const VIEW = { x: 40, y: 190, w: 1000, h: 800 };

// Sizes in map units: at the camera's scale 1 they are pixels of the video.
const NAME = 38;
const SUB = 21;
const LABEL = 24;
const measure: Measure = {
  node: (p) => [Math.max(240, Math.max(p.name.length * NAME * 0.58, p.sub.length * SUB * 0.6) + 64), p.sub ? 100 : 84],
  label: (text) => [text.length * LABEL * 0.6 + 18, LABEL + 12],
  pad: (g) => `[top=${g.kind === "zone" ? 70 : 60},left=30,bottom=30,right=30]`,
};
// A phone's width, and the smallest text it must show a card's words at, in its pixels.
const PHONE = 390;
const MIN_PX = 9;

// The map shows at most this many parts, so a phone reads their names on the whole map: the tour's, then their
// neighbours while there is room.
const MOST = 6;

const ms = (s: number) => Math.round(s * 1000);
const pad = (b: Box, n: number): Box => ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const fit = (b: Box, fill: number) => Math.min((VIEW.w * fill) / b.w, (VIEW.h * fill) / b.h);
const camOn = (b: Box, s: number): Cam => [b.x + b.w / 2, b.y + b.h / 2, s];
const boxOf = (b: number[]): Box => ({ x: b[0], y: b[1], w: b[2], h: b[3] });
const hits = (r: Box, o: Box) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
const pointsOf = (d: string) => [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => [+m[1], +m[2]] as [number, number]);
const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");

// A spoken line in pieces that fit two lines of the caption, each shown for its share of the speech.
export function chunks(text: string, max = 56): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  // Pieces of about equal length, broken after punctuation when one is near, so no word is left on its own.
  const limit = Math.min(max, Math.ceil(text.length / Math.ceil(text.length / max)) + 10);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && `${cur} ${w}`.length > limit) {
      // A piece doesn't end on a word that leads into the next: "with", "the", "a"…
      const tail = cur.match(/^(.*\S)\s+(a|an|the|with|to|of|and|or|for|in|on|at|by|from|its|their|so|if|but)$/i);
      if (tail) {
        out.push(tail[1]);
        cur = `${tail[2]} ${w}`;
        continue;
      }
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
    if (/[,.;:!?—]$/.test(w) && cur.length >= limit * 0.6) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  const last = out.at(-1) ?? "";
  if (out.length > 1 && last.length < 16 && `${out.at(-2)} ${last}`.length <= max + 8) out.splice(-2, 2, `${out.at(-2)} ${last}`);
  return out;
}

// The parts in the order the tour meets them, in rows of two that turn at each end like a snake, and each edge
// along the gaps between them: straight between neighbours, else out to the middle channel and back in.
const CELL = { w: 440, h: 100, gx: 160, gy: 140 };
// How far apart two edges' lanes run in the gaps.
const LANE = 22;
// Room outside the two columns for an edge that rounds one of them.
const OUT = 70;
export function snake(parts: MapPart[], edges: { from: string; to: string; label: string; dashed?: boolean }[], order: string[]): System {
  const ids = [...new Set([...order, ...parts.map((p) => p.id)])].filter((id) => parts.some((p) => p.id === id));
  type Cell = { row: number; col: number; x: number; y: number };
  const cell = new Map<string, Cell>(
    ids.map((id, i) => {
      const row = Math.floor(i / 2);
      const col = row % 2 ? 1 - (i % 2) : i % 2;
      return [id, { row, col, x: OUT + col * (CELL.w + CELL.gx), y: row * (CELL.h + CELL.gy) }];
    }),
  );
  const rows = Math.ceil(ids.length / 2);
  const mid = OUT + CELL.w + CELL.gx / 2;
  const width = 2 * OUT + 2 * CELL.w + CELL.gx;
  const cx = (c: Cell) => c.x + CELL.w / 2;
  const cy = (c: Cell) => c.y + CELL.h / 2;
  const direct = (a: Cell, b: Cell) => a.row === b.row || (a.col === b.col && Math.abs(a.row - b.row) === 1);
  // Edges that leave by the channels each get a lane of their own, so no two run on the same line.
  const channel = edges.filter((e) => !direct(cell.get(e.from) as Cell, cell.get(e.to) as Cell));
  const lane = (e: (typeof edges)[number]) => (channel.indexOf(e) - (channel.length - 1) / 2) * LANE;
  const legs = edges.map((e): [number, number][] => {
    const a = cell.get(e.from) as Cell;
    const b = cell.get(e.to) as Cell;
    if (a.row === b.row) return [[a.col < b.col ? a.x + CELL.w : a.x, cy(a)], [b.col < a.col ? b.x + CELL.w : b.x, cy(b)]];
    const down = b.row > a.row;
    const ya = down ? a.y + CELL.h : a.y;
    const yb = down ? b.y : b.y + CELL.h;
    if (direct(a, b)) return [[cx(a), ya], [cx(b), yb]];
    const off = lane(e);
    // Two parts of one column, rows apart: round the outside of that column, clear of everything between them.
    if (a.col === b.col) {
      const left = a.col === 0;
      const side = left ? a.x : a.x + CELL.w;
      const x = left ? OUT / 2 + off / 2 : width - OUT / 2 + off / 2;
      return [[side, cy(a) + off / 3], [x, cy(a) + off / 3], [x, cy(b) - off / 3], [side, cy(b) - off / 3]];
    }
    // Out of the source into the gap beside its row, along it to the middle channel, along that, and into the
    // target: every leg in this edge's own lane.
    const ga = ya + (down ? CELL.gy / 2 : -CELL.gy / 2) + off;
    const gb = yb + (down ? -CELL.gy / 2 : CELL.gy / 2) - off;
    return [[cx(a) + off, ya], [cx(a) + off, ga], [mid + off, ga], [mid + off, gb], [cx(b) + off, gb], [cx(b) + off, yb]];
  });
  // Each label goes beside a leg of its own edge, where it covers no box, no line and no other label.
  const boxes: Box[] = [...cell.values()].map((c) => ({ x: c.x - 6, y: c.y - 6, w: CELL.w + 12, h: CELL.h + 12 }));
  const segs = legs.flatMap((pts) => pts.slice(1).map((q, i) => [pts[i], q] as const));
  const crosses = (r: Box) => segs.some(([p, q]) => hits(r, { x: Math.min(p[0], q[0]) - 2, y: Math.min(p[1], q[1]) - 2, w: Math.abs(p[0] - q[0]) + 4, h: Math.abs(p[1] - q[1]) + 4 }));
  const placed: Box[] = [];
  const routed = edges.map((e, n) => {
    const pts = legs[n];
    const w = e.label.length * LABEL * 0.6 + 8;
    const h = LABEL + 6;
    const tries: { at: [number, number]; anchor: "start" | "middle" | "end"; r: Box }[] = [];
    const byLength = pts.slice(1).map((q, i) => [pts[i], q] as const).sort(([a, b], [c, d]) => Math.hypot(d[0] - c[0], d[1] - c[1]) - Math.hypot(b[0] - a[0], b[1] - a[1]));
    // Beside the middle of each leg, longest first, then a quarter of the way along either end.
    for (const f of [0.5, 0.3, 0.7])
      for (const [p, q] of byLength) {
        const mx = p[0] + (q[0] - p[0]) * f;
        const my = p[1] + (q[1] - p[1]) * f;
        if (p[1] === q[1]) {
          tries.push({ at: [mx, my - 12], anchor: "middle", r: { x: mx - w / 2, y: my - 12 - h + 6, w, h } });
          tries.push({ at: [mx, my + h + 4], anchor: "middle", r: { x: mx - w / 2, y: my + 10, w, h } });
        } else {
          tries.push({ at: [mx + 14, my + 8], anchor: "start", r: { x: mx + 10, y: my + 8 - h + 6, w, h } });
          tries.push({ at: [mx - 14, my + 8], anchor: "end", r: { x: mx - 10 - w, y: my + 8 - h + 6, w, h } });
        }
      }
    const within = (r: Box) => r.x >= 0 && r.x + r.w <= width && r.y >= -20 && r.y + r.h <= rows * (CELL.h + CELL.gy);
    const free = tries.find((c) => within(c.r) && !boxes.some((b) => hits(c.r, b)) && !crosses(c.r) && !placed.some((o) => hits(c.r, o))) ?? tries[0];
    placed.push(free.r);
    return { d: pathOf(pts), label: e.label, at: [Math.round(free.at[0]), Math.round(free.at[1])] as [number, number], anchor: free.anchor, from: e.from, to: e.to, ...(e.dashed ? { dashed: true } : {}) };
  });
  return {
    size: [width, rows * CELL.h + (rows - 1) * CELL.gy],
    groups: [],
    parts: ids.map((id) => {
      const c = cell.get(id) as Cell;
      return { ...(parts.find((p) => p.id === id) as MapPart), box: [c.x, c.y, CELL.w, CELL.h] as [number, number, number, number] };
    }),
    edges: routed,
  };
}

// Where a laid-out map's edge labels collide: with another label, a part, or a line that isn't their own edge's.
// The layout is chosen to have none; the render gate measures the drawn page for the same.
export function clashes(map: System): string[] {
  const labels = map.edges.map((e) => {
    const w = e.label.length * LABEL * 0.6;
    const x = e.anchor === "start" ? e.at[0] : e.anchor === "end" ? e.at[0] - w : e.at[0] - w / 2;
    return { e, r: { x, y: e.at[1] - LABEL * 0.78, w, h: LABEL * 1.02 } };
  });
  const out: string[] = [];
  for (const [i, { e, r }] of labels.entries()) {
    for (const o of labels.slice(i + 1)) if (hits(r, o.r)) out.push(`"${e.label}" overlaps "${o.e.label}"`);
    for (const p of map.parts) if (hits(r, boxOf(p.box))) out.push(`"${e.label}" overlaps ${p.name}`);
    for (const other of map.edges) {
      if (other === e) continue;
      const pts = pointsOf(other.d);
      for (let k = 1; k < pts.length; k++) {
        const [a, b] = [pts[k - 1], pts[k]];
        const seg = { x: Math.min(a[0], b[0]) - 1, y: Math.min(a[1], b[1]) - 1, w: Math.abs(a[0] - b[0]) + 2, h: Math.abs(a[1] - b[1]) + 2 };
        if (hits(r, seg)) {
          out.push(`"${e.label}" lies on the line of "${other.label}"`);
          break;
        }
      }
    }
  }
  return out;
}

export async function tour(o: { storyboard: Storyboard; system: System; look: Look; timeline: Timeline }) {
  const sb = o.storyboard;
  const meaning = meaningOf(o.system);
  const on = new Set(sb.stops.map((s) => s.part));
  const near = new Map<string, number>();
  for (const e of meaning.edges)
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) if (on.has(a) && !on.has(b)) near.set(b, (near.get(b) ?? 0) + 1);
  for (const [id] of [...near].sort((a, b) => b[1] - a[1])) if (on.size < MOST) on.add(id);
  const parts: MapPart[] = meaning.parts.filter((p) => on.has(p.id));
  // A group stays when it holds a shown part, itself or through a group inside it.
  const holds = (label: string): boolean => meaning.groups.some((g) => g.label === label && (g.members.some((m) => on.has(m)) || meaning.groups.some((c) => c.parent === label && holds(c.label))));
  const groups = meaning.groups.filter((g) => holds(g.label)).map((g) => ({ ...g, members: g.members.filter((m) => on.has(m)) }));
  const edges = meaning.edges.filter((e) => on.has(e.from) && on.has(e.to));

  // Top to bottom or left to right, with the map's groups or without: whichever the portrait frame shows largest,
  // so a phone reads the names on the whole map. Groups stay unless dropping them makes it a seventh larger.
  // A long chain may wrap into rows to suit the frame.
  const tries = await Promise.all(
    [true, false].flatMap((grouped) =>
      ["DOWN", "RIGHT"].flatMap((dir) =>
        ["OFF", "MULTI_EDGE"].map(async (wrap) => {
          const options = { "elk.direction": dir, "elk.spacing.nodeNode": "32", "elk.layered.spacing.nodeNodeBetweenLayers": "60", "elk.spacing.edgeLabel": "8", "elk.layered.wrapping.strategy": wrap, "elk.aspectRatio": "1.25" };
          const laid = await layout({ parts, groups: grouped ? groups : [], edges }, options, measure);
          return { laid, scale: fit({ x: 0, y: 0, w: laid.size[0], h: laid.size[1] }, 1) * (grouped ? 1.15 : 1) };
        }),
      ),
    ),
  );
  // A loop or a long chain lays out tall and thin; then the tour's own order on a two-column grid reads larger.
  const grid = snake(parts, edges, sb.stops.map((s) => s.part));
  // It shows no groups, so it wins over a grouped layout only when clearly larger; over an ungrouped one, when larger.
  tries.push({ laid: grid, scale: fit({ x: 0, y: 0, w: grid.size[0], h: grid.size[1] }, 1) });
  // The largest whose edge labels are clear of each other, of the parts and of other edges' lines.
  const clear = tries.filter((x) => !clashes(x.laid).length);
  const map = (clear.length ? clear : tries).sort((a, b) => b.scale - a.scale)[0].laid;
  const box = new Map(map.parts.map((p) => [p.id, boxOf(p.box)]));
  const whole: Box = { x: 0, y: 0, w: map.size[0], h: map.size[1] };
  const sAll = Math.min(fit(whole, 0.92), 1.3);
  const overview: Cam = camOn(whole, sAll);
  const tl = o.timeline;
  const open = tl.beats[0];
  const close = tl.beats[tl.beats.length - 1];
  const stopBeats = tl.beats.filter((b) => b.kind === "stop");
  const tracks: Track[] = [];
  const name = new Map(map.parts.map((p) => [p.id, p.name]));

  // Each stop: its card when the part opens, its camera, and the path it arrived by. A card is the part's insides,
  // as the move the stop picked (templates/motion/moves.ts), each beat played as its sentence is said.
  const cards = sb.stops.map((s, i) => {
    const m = moveOf(s);
    if (!m) return null;
    const b = box.get(s.part) as Box;
    const beat = stopBeats[i];
    const t0 = beat.start + beat.travel + 0.35;
    const voiced = spoken(s).length > 0;
    // A storyboard whose beats have no sentences spreads them over the stop's line, a failure a slot of its own.
    const slots = m.beats.length + m.beats.filter((x) => x.fail).length;
    const from = Math.max(t0 + 0.6, beat.speak + 0.3);
    const slot = (Math.max(from + 0.8 * slots, beat.end - 0.9) - from) / Math.max(1, slots);
    const before = (k: number) => k + m.beats.slice(0, k).filter((x) => x.fail).length;
    const clock: Clock = {
      at: (k) => ms(voiced ? Math.max(t0 + 0.5, beat.segs[k + 1].speak) : from + before(k) * slot),
      len: (k) => ms(voiced ? beat.segs[k + 1].speech : slot * 2),
      open: ms(t0 + 0.3),
      end: ms(beat.end - 0.4),
    };
    const built = build(`mv${i}`, s, m.move, m.beats, clock);
    const label = name.get(s.part) ?? "";
    const w = Math.max(built.w, b.w + 30, label.length * 34 * 0.56 + 60);
    const x = b.x + b.w / 2 - w / 2;
    // Over the part's number and badge, which would otherwise peek above it.
    const y = b.y - 48;
    const zoom = (built.zoom ?? []).map((z) => ({ at: z.at, box: { x: x + z.box.x, y: y + z.box.y, w: z.box.w, h: z.box.h } }));
    return { i, x, y, w, h: built.h, name: label, move: m.move, shapes: built.shapes, tracks: built.tracks, zoom, texts: textsOf(built.shapes), clips: built.clips ?? [] };
  });
  const cams: Cam[] = sb.stops.map((s, i) => {
    const b = box.get(s.part) as Box;
    const c = cards[i];
    // A card is framed with a margin of map around it, so the part stays in its place.
    const frame = c ? pad({ x: c.x, y: c.y, w: c.w, h: c.h }, 56) : pad(b, 160);
    return camOn(frame, Math.max(sAll, Math.min(fit(frame, 0.92), c ? 1.4 : 1.3)));
  });
  // Every word a card shows, as big as a phone 390 px wide shows it: the smallest at the camera's widest view of it.
  const legibility = cards.flatMap((c, i) => {
    if (!c) return [];
    const px = (size: number) => (size * cams[i][2] * PHONE) / 1080;
    const small = c.texts.filter((t) => px(t.size) < MIN_PX);
    const clipped = c.clips.map((x) => `stop ${i + 1} (${sb.stops[i].part}): ${x}`);
    return small.length ? [...clipped, `stop ${i + 1} (${sb.stops[i].part}): its ${c.move} shows "${small[0].text}" at ${px(small[0].size).toFixed(1)} px on a phone, under ${MIN_PX}; shorten its labels or use fewer, so the card fits closer`] : clipped;
  });
  const trails = sb.stops.map((s, i) => {
    if (i === 0) return null;
    const prev = sb.stops[i - 1].part;
    const e = s.via && s.via !== INSIDE ? map.edges.find((x) => x.label === s.via && ((x.from === prev && x.to === s.part) || (x.from === s.part && x.to === prev))) : undefined;
    let pts: [number, number][];
    if (e) {
      pts = pointsOf(e.d);
      if (e.from !== prev) pts.reverse();
    } else {
      // Inside one frame, or along an edge the map doesn't draw: straight from one part to the other.
      const a = box.get(prev) as Box;
      const b = box.get(s.part) as Box;
      pts = [
        [a.x + a.w / 2, a.y + a.h / 2],
        [b.x + b.w / 2, b.y + b.h / 2],
      ];
    }
    return { i, d: pathOf(pts) };
  });

  // The camera: the whole map, then each stop (swinging out over a long move), then the whole map again.
  const cam: [number, number, number, number][] = [[0, ...overview]];
  cam.push([ms(open.end - 0.2), ...overview]);
  for (const b of stopBeats) {
    const i = b.index;
    if (i > 0) {
      const u = pad(union(box.get(sb.stops[i - 1].part) as Box, box.get(sb.stops[i].part) as Box), 90);
      const sMid = Math.max(sAll, Math.min(fit(u, 0.92), cams[i - 1][2], cams[i][2]));
      if (sMid < Math.min(cams[i - 1][2], cams[i][2]) * 0.85) cam.push([ms(b.start + b.travel * 0.5), ...camOn(u, sMid)]);
    }
    cam.push([ms(b.start + b.travel), ...cams[i]]);
    // A move that goes inside (layers) takes the camera in, one ring a beat, and holds the last.
    let held = cams[i];
    for (const z of cards[i]?.zoom ?? []) {
      const t = Math.min(Math.max(z.at, ms(b.start + b.travel) + 1), ms(b.end) - 1);
      const next = camOn(z.box, Math.min(fit(z.box, 0.92), 2));
      cam.push([t, ...held], [t + 700, ...next]);
      held = next;
    }
    cam.push([ms(b.end), ...held]);
  }
  cam.push([ms(close.start + close.travel), ...overview]);
  tracks.push({ el: "cam", p: "cam", k: cam });

  // The title, word by word, then the map assembles under it.
  const words = sb.title.split(/\s+/);
  // The title and its question hold for the first half of the opening line; then the map assembles under it.
  const lag = Math.max(0, open.end * 0.5 - 3.1);
  tracks.push({ el: "kick", p: "o", k: [[150, 0], [550, 1], [ms(3.1 + lag), 1], [ms(3.6 + lag), 0]] });
  // The question goes with the title.
  tracks.push({ el: "question", p: "o", k: [[ms(1.1), 0], [ms(1.6), 1], [ms(3.1 + lag), 1], [ms(3.6 + lag), 0]] });
  for (const k of words.keys()) {
    const t = 300 + k * 110;
    tracks.push({ el: `tw-${k}`, p: "o", k: [[t, 0], [t + 380, 1], [ms(3.1 + lag), 1], [ms(3.6 + lag), 0]] });
    tracks.push({ el: `tw-${k}`, p: "ty", k: [[t, 46], [t + 480, 0], [ms(3.1 + lag), 0], [ms(3.6 + lag), -36]], e: "o" });
  }
  tracks.push({ el: "flowbar", p: "o", k: [[ms(3.4 + lag), 0], [ms(3.9 + lag), 1]] });
  // The map assembles once the title has gone, never under it.
  const mapAt = 3.6 + lag;
  const built = (i: number, n: number) => ms(mapAt + 0.3 + (i / Math.max(1, n)) * 1.6);

  // Parts: in, then dimmed when the camera is elsewhere, and on at the end if the tour passed them.
  const order = [...map.parts].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  const visited = new Set(sb.stops.map((s) => s.part));
  for (const [n, p] of order.entries()) {
    const k: [number, number][] = [[built(n, order.length), 0], [built(n, order.length) + 450, 1]];
    for (const b of stopBeats) {
      const here = sb.stops[b.index].part === p.id;
      const seen = sb.stops.slice(0, b.index).some((s) => s.part === p.id);
      const v = here ? 1 : seen ? 0.7 : 0.34;
      k.push([ms(b.start + 0.2), k[k.length - 1][1]], [ms(b.start + b.travel), v]);
    }
    k.push([ms(close.start), k[k.length - 1][1]], [ms(close.start + close.travel), visited.has(p.id) ? 1 : 0.45]);
    tracks.push({ el: `part-${p.id}`, p: "o", k });
    tracks.push({ el: `part-${p.id}`, p: "s", k: [[built(n, order.length), 0.86], [built(n, order.length) + 450, 1]], e: "o" });
    // A part's small print shows only while the camera is on it; the whole map reads by names alone.
    if (p.sub) {
      const sub: [number, number][] = [[0, 0]];
      for (const b of stopBeats) {
        const here = sb.stops[b.index].part === p.id ? 1 : 0;
        sub.push([ms(b.start + b.travel * 0.6), sub[sub.length - 1][1]], [ms(b.start + b.travel), here]);
      }
      sub.push([ms(close.start), sub[sub.length - 1][1]], [ms(close.start + 0.6), 0]);
      tracks.push({ el: `sub-${p.id}`, p: "o", k: sub });
      tracks.push({ el: `nm-${p.id}`, p: "ty", k: sub.map(([t, v]) => [t, (1 - v) * SUB * 0.85]) });
    }
  }
  for (const n of map.groups.keys()) tracks.push({ el: `grp-${n}`, p: "o", k: [[ms(mapAt) + n * 120, 0], [ms(mapAt + 0.6) + n * 120, 1]] });
  for (const [n, e] of map.edges.entries()) {
    // A dashed edge can't be drawn in by its dashes; it fades in.
    if (e.dashed) tracks.push({ el: `edge-${n}`, p: "o", k: [[ms(mapAt + 1) + n * 70, 0], [ms(mapAt + 2) + n * 70, 1]] });
    else tracks.push({ el: `edge-${n}`, p: "dash", k: [[ms(mapAt + 1) + n * 70, 1], [ms(mapAt + 2) + n * 70, 0]], e: "o" });
    // A label is too small to read on the whole map; it shows when the camera is on one of its ends.
    const k: [number, number][] = [[0, 0]];
    for (const b of stopBeats) {
      const part = sb.stops[b.index].part;
      const on = e.from === part || e.to === part ? 0.9 : 0;
      k.push([ms(b.start + b.travel * 0.5), k[k.length - 1][1]], [ms(b.start + b.travel), on]);
      // An opened part covers the map around it; labels half under it would read cut off, so they step out.
      if (on && moveOf(sb.stops[b.index])) k.push([ms(b.start + b.travel + 0.3), on], [ms(b.start + b.travel + 0.6), 0]);
    }
    k.push([ms(close.start), k[k.length - 1][1]], [ms(close.start + 0.5), 0]);
    tracks.push({ el: `elabel-${n}`, p: "o", k });
  }

  // The tour: the packet runs each path and leaves it lit; the part it reaches lights and, with things inside, opens.
  const lit: [number, number][] = [];
  const scrim: [number, number][] = [];
  for (const b of stopBeats) {
    const i = b.index;
    const arrive = b.start + b.travel;
    const tr = trails[i];
    if (tr) {
      const k: [number, number][] = [[ms(b.start + 0.15), 0], [ms(arrive), 1]];
      tracks.push({ el: `trail-${i}`, p: "dash", k: k.map(([t, v]) => [t, 1 - v]), e: "io" });
      tracks.push({ el: `trailglow-${i}`, p: "dash", k: k.map(([t, v]) => [t, 1 - v]), e: "io" });
      tracks.push({ el: "packet", p: "along", path: `trail-${i}`, k, e: "io" });
      lit.push([ms(b.start + 0.1), 0], [ms(b.start + 0.2), 1], [ms(arrive - 0.05), 1], [ms(arrive + 0.25), 0]);
    }
    // Lit while the camera is here, then dimmer, and on again in the pull-back; the last stop goes straight to that.
    const dim: [number, number][] = i === sb.stops.length - 1 ? [] : [[ms(b.end + 0.4), 0.4], [ms(close.start), 0.4]];
    tracks.push({ el: `hl-${i}`, p: "o", k: [[ms(arrive - 0.1), 0], [ms(arrive + 0.25), 1], [ms(b.end), 1], ...dim, [ms(close.start + close.travel), 0.8]] });
    tracks.push({ el: `ring-${i}`, p: "o", k: [[ms(arrive - 0.05), 0], [ms(arrive + 0.05), 0.9], [ms(arrive + 0.9), 0]] });
    tracks.push({ el: `ring-${i}`, p: "s", k: [[ms(arrive), 1], [ms(arrive + 0.9), 1.35]], e: "o" });
    tracks.push({ el: `num-${i}`, p: "o", k: [[ms(arrive + 0.1), 0], [ms(arrive + 0.4), 1]] });
    tracks.push({ el: `num-${i}`, p: "s", k: [[ms(arrive + 0.1), 0.4], [ms(arrive + 0.5), 1]], e: "o" });
    const c = cards[i];
    if (c) {
      const t0 = arrive + 0.3;
      tracks.push({ el: `card-${i}`, p: "o", k: [[ms(t0), 0], [ms(t0 + 0.3), 1], [ms(b.end - 0.35), 1], [ms(b.end), 0]] });
      tracks.push({ el: `card-${i}`, p: "s", k: [[ms(t0), 0.6], [ms(t0 + 0.5), 1], [ms(b.end - 0.35), 1], [ms(b.end), 0.92]], e: "o" });
      // The map behind steps back, so what the card covers doesn't peek out around it.
      scrim.push([ms(t0), 0], [ms(t0 + 0.3), 0.8], [ms(b.end - 0.35), 0.8], [ms(b.end), 0]);
      tracks.push(...c.tracks);
    }
    // What the stop is, under the map, while it lasts.
    tracks.push({ el: `sh-${i}`, p: "o", k: [[ms(b.start + 0.2), 0], [ms(b.start + 0.5), 1], [ms(b.end - 0.1), 1], [ms(b.end + 0.15), 0]] });
    tracks.push({ el: `dot-${i}`, p: "o", k: [[ms(arrive), 0.25], [ms(arrive + 0.3), 1]] });
  }
  if (lit.length) tracks.push({ el: "packet", p: "o", k: lit });
  tracks.push({ el: "scrim", p: "o", k: scrim.length ? scrim : [[0, 0]] });

  // What today changed: a badge on the part, pulsing, with the PRs it cites.
  const today = new Map<string, Ref[]>();
  for (const s of sb.stops) if (s.today?.length) today.set(s.part, [...new Set([...(today.get(s.part) ?? []), ...s.today])]);
  for (const id of today.keys()) {
    tracks.push({ el: `badge-${id}`, p: "o", k: [[ms(mapAt + 2.2), 0], [ms(mapAt + 2.7), 1]] });
    tracks.push({ el: `badge-${id}`, p: "pulse", from: ms(mapAt + 2.7), period: 1600, amp: 0.07 });
  }

  // Captions: each sentence in pieces, each piece for its share of the sentence's speech; a beat's last piece stays
  // up a moment after it is said, the others until the next is said.
  const captions: { id: string; text: string }[] = [];
  const said = groupsOf(sb);
  for (const [n, b] of tl.beats.entries()) {
    for (const [g, seg] of b.segs.entries()) {
      const pieces = chunks(said[n][g]);
      const total = pieces.reduce((a, p) => a + p.length, 0);
      const next = b.segs[g + 1]?.speak;
      let t = seg.speak;
      for (const [k, p] of pieces.entries()) {
        const d = (seg.speech * p.length) / total;
        const id = `cap-${n}-${g}-${k}`;
        const last = k === pieces.length - 1;
        // The closing line clears before the end card comes up.
        const out = !last ? t + d : next !== undefined ? next : Math.min(seg.speak + seg.speech + (b.kind === "close" ? 0.05 : 0.5), b.end - 0.1);
        // A clean cut between pieces: one fades out, then the next fades in, never both at once.
        const first = k === 0 && g === 0;
        tracks.push({ el: id, p: "o", k: [[ms(t - (first ? 0.12 : 0)), 0], [ms(t + 0.12), 1], [ms(out - 0.12), 1], [ms(out), 0]] });
        tracks.push({ el: id, p: "ty", k: [[ms(t - 0.12), 14], [ms(t + 0.2), 0]], e: "o" });
        captions.push({ id, text: p });
        t += d;
      }
    }
  }
  const endAt = close.speak + close.speech + 0.3;
  tracks.push({ el: "endcard", p: "o", k: [[ms(endAt), 0], [ms(endAt + 0.5), 1]] });
  tracks.push({ el: "endcard", p: "ty", k: [[ms(endAt), 20], [ms(endAt + 0.6), 0]], e: "o" });

  // Numbers on the parts: a part passed twice shows both, side by side.
  const seenAt = new Map<string, number>();
  const nums = sb.stops.map((s, i) => {
    const b = box.get(s.part) as Box;
    const n = seenAt.get(s.part) ?? 0;
    seenAt.set(s.part, n + 1);
    return { i, n: i + 1, x: b.x + 4 + n * 62, y: b.y + 4 };
  });

  const date = new Date(`${o.look.date}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  return {
    tracks,
    legibility,
    moves: sb.stops.map((st, i) => ({ part: st.part, move: cards[i]?.move ?? null })),
    fields: {
      look: { ...o.look, dateLabel: date },
      title: { kicker: sb.flow, question: sb.question, words: words.map((w, k) => ({ id: `tw-${k}`, text: w })) },
      flow: sb.flow,
      groups: map.groups.map((g, n) => {
        const b = boxOf(g.box);
        return { id: `grp-${n}`, label: g.label, kind: g.kind, ...b, ly: b.y + (g.kind === "zone" ? 40 : 36) };
      }),
      parts: map.parts.map((p) => {
        const b = boxOf(p.box);
        return { id: p.id, name: p.name, sub: p.sub, ...b, cx: b.x + b.w / 2, nameY: b.y + (p.sub ? b.h / 2 - 4 : b.h / 2 + NAME * 0.35), subY: b.y + b.h / 2 + 30, badge: today.has(p.id) ? { x: b.x + b.w - 14, y: b.y - 18 } : null };
      }),
      edges: map.edges.map((e, n) => ({ id: `edge-${n}`, label: `elabel-${n}`, d: e.d, text: e.label, x: e.at[0], y: e.at[1], anchor: e.anchor ?? "middle", dashed: Boolean(e.dashed) })),
      hls: sb.stops.map((s, i) => ({ id: `hl-${i}`, ring: `ring-${i}`, ...(box.get(s.part) as Box) })),
      nums,
      trails: trails.filter((t) => t !== null),
      cards: cards.filter((c) => c !== null),
      heads: sb.stops.map((s, i) => {
        const via = i === 0 ? "where it starts" : s.via === INSIDE ? "inside" : `via ${s.via}`;
        return { id: `sh-${i}`, n: String(i + 1).padStart(2, "0"), of: String(sb.stops.length).padStart(2, "0"), name: name.get(s.part), via, today: [...(s.today ?? []).slice(0, 2).map(refLabel), ...((s.today ?? []).length > 2 ? [`+${(s.today ?? []).length - 2}`] : [])].join(" · ") };
      }),
      dots: sb.stops.map((_, i) => ({ id: `dot-${i}` })),
      captions,
      end: { title: sb.title },
    },
  };
}
