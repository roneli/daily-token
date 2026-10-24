// Positions and timing for the state-machine reel. The template only places what this returns.
// The token sits on a box's top edge: on its centre it covered the state's name.
// Type is as large as the words allow (fit.ts), and the boxes, the branch and the status row grow with it.

import { fit, MONO, SANS } from "./fit";

type State = { id: string; name: string; sub: string };
type Branch = State & { from: string; label?: string };
type Step = { to: string; state: string; line: string; tone?: "on" | "bad" | "good"; note?: string };
type Run = { caption: string; start: { state: string; line: string }; steps: Step[] };
type Box = State & { x: number; y: number; w: number; h: number; cx: number; cy: number };

const PAUSE = 250;
const MOVE = 500;
const DWELL = 550;
const SAME = 900;
const NOTE = 300;
const BACK = 600;
const ROW_Y = 70;
const STATUS_X = 34;
const CLS = { on: "on", bad: "bad-on", good: "good-on" };

export function layout(raw: Record<string, unknown>) {
  const states = raw.states as State[];
  const branch = raw.branch as Branch | undefined;
  const runs = raw.runs as Run[];
  const n = states.length;
  const gap = 35;
  const w = (600 - gap * (n - 1)) / n;

  // One size for every box and the branch, set by the longest name and sub.
  const named = [...states, ...(branch ? [branch] : [])];
  const nameSize = fit(named.map((s) => s.name), w - 14, 21, 14, SANS);
  const subSize = fit(named.map((s) => s.sub), w - 14, 16, 11);
  // A line's box reaches about a third of its size below the baseline: the sub starts under the name's.
  const gapY = Math.round(subSize + nameSize * 0.3 + 4);
  const ROW_H = 8 + nameSize + gapY + Math.round(subSize * 0.3) + 10;
  const BRANCH_Y = ROW_Y + ROW_H + 62;
  const BRANCH_H = ROW_H;
  const nameY = 8 + nameSize;
  const subY = nameY + gapY;
  const loopText = (raw.loop as string | undefined) ?? "";
  const notesText = runs.flatMap((r) => r.steps.map((s) => s.note ?? ""));
  const labelSize = fit([loopText, branch?.label ?? "", ...notesText], 150, 16, 12);
  const captionSize = fit(runs.map((r) => r.caption), 600, 18, 13);

  const boxes = states.map((s, i) => {
    const x = 20 + i * (w + gap);
    return { ...s, x, y: ROW_Y, w, h: ROW_H, cx: x + w / 2, cy: ROW_Y + ROW_H / 2, ax1: x + w, ax2: x + w + gap - 2 };
  });
  const all = new Map<string, Box>(boxes.map((b) => [b.id, b]));

  let laidBranch: (Box & { from: string; label?: string; ay1: number; ay2: number; lx: number; ly: number }) | null = null;
  if (branch) {
    const from = all.get(branch.from);
    if (!from) throw new Error(`state-machine: branch.from "${branch.from}" is not a state`);
    laidBranch = { ...branch, x: from.x, y: BRANCH_Y, w: from.w, h: BRANCH_H, cx: from.cx, cy: BRANCH_Y + BRANCH_H / 2, ay1: ROW_Y + ROW_H, ay2: BRANCH_Y - 2, lx: from.cx + 8, ly: raw.loop ? ROW_Y + ROW_H + labelSize + 4 : (ROW_Y + ROW_H + BRANCH_Y) / 2 + labelSize / 3 };
    all.set(branch.id, laidBranch);
  }

  const first = boxes[0];
  const last = boxes[n - 1];
  // The loop's label sits under its curve, unless the branch arrow runs through there: then it drops below the curve
  // on the arrow's left, and the branch label (moved up under its box) keeps the right.
  const centre = (first.cx + last.cx) / 2;
  const clash = laidBranch && Math.abs(laidBranch.cx - centre) < (loopText.length * labelSize * MONO) / 2 + 10;
  const bend = ROW_Y + ROW_H + 50;
  const loop = raw.loop
    ? {
        label: loopText,
        d: `M${last.cx},${ROW_Y + ROW_H} C${last.cx},${bend} ${first.cx},${bend} ${first.cx},${ROW_Y + ROW_H + 2}`,
        lx: clash && laidBranch ? laidBranch.cx - 12 : centre,
        ly: clash ? bend + labelSize : bend - 6,
        anchor: clash ? "end" : "middle",
      }
    : null;

  const moves: { at: number; ms: number; x: number; y: number }[] = [];
  const cues: { id: string; at: number; cls: string }[] = [];
  const texts: { target: string; at: number; to: string }[] = [];
  const notes: { text: string; tone: string; at: number; x: number; y: number; anchor: string }[] = [];
  const status = (at: number, state: string, line: string) => {
    texts.push({ target: "st", at, to: state }, { target: "line", at, to: line });
  };

  let t = 100;
  let at = first.id;
  cues.push({ id: at, at: t, cls: "on" });
  runs.forEach((run, r) => {
    if (r > 0) {
      texts.push({ target: "cap", at: t, to: run.caption });
      if (at !== first.id) {
        moves.push({ at: t, ms: BACK, x: first.cx, y: first.y });
        cues.push({ id: at, at: t, cls: "" }, { id: first.id, at: t + BACK, cls: "on" });
        at = first.id;
      }
      status(t + BACK, run.start.state, run.start.line);
      t += BACK + 300;
    }
    for (const s of run.steps) {
      const from = all.get(at) as Box;
      const target = all.get(s.to);
      if (!target) throw new Error(`state-machine: step to "${s.to}" is not a state`);
      t += PAUSE;
      if (s.to === at) {
        status(t, s.state, s.line);
        t += SAME - PAUSE;
        continue;
      }
      if (s.note) {
        // On the branch's vertical arrow the branch label holds the right side, so the note takes the left.
        const vertical = from.cx === target.cx;
        notes.push({ text: s.note, tone: s.tone === "good" ? "good" : "bad", at: t, x: vertical ? from.cx - 10 : (from.cx + target.cx) / 2 + 10, y: (from.cy + target.cy) / 2 + labelSize / 3, anchor: vertical ? "end" : "start" });
        t += NOTE;
      }
      moves.push({ at: t, ms: MOVE, x: target.cx, y: target.y });
      cues.push({ id: at, at: t, cls: "" }, { id: s.to, at: t + MOVE, cls: CLS[s.tone ?? "on"] });
      status(t + MOVE, s.state, s.line);
      at = s.to;
      t += MOVE + DWELL;
    }
  });

  // The status row: its label, the state and its line, one size, each after the one before.
  const label = (raw.status as string | undefined) ?? "";
  const stateLen = Math.max(...runs.flatMap((r) => [r.start.state, ...r.steps.map((s) => s.state)]).map((x) => x.length));
  const lineLen = Math.max(...runs.flatMap((r) => [r.start.line, ...r.steps.map((s) => s.line)]).map((x) => x.length));
  const statusSize = fit(["x".repeat(label.length + stateLen + lineLen + 6)], 572, 17, 12);
  const statusY = Math.max(268, (laidBranch ? BRANCH_Y + BRANCH_H : bend + labelSize) + 16);
  const statusH = statusSize + 28;
  const stateX = STATUS_X + (label.length + 3) * statusSize * MONO;
  const lineX = stateX + (stateLen + 3) * statusSize * MONO;

  return {
    fields: {
      boxes, branch: laidBranch, loop, status: label, caption: runs[0].caption, start: runs[0].start, tok: { x: first.cx, y: first.y }, moves, cues, texts, notes,
      size: { name: nameSize, sub: subSize, nameY, subY, label: labelSize, caption: captionSize, status: statusSize },
      row: { y: statusY, h: statusH, textY: statusY + statusH / 2 + statusSize / 3, stateX, lineX, labelX: STATUS_X },
    },
    ms: Math.round(t + 600),
  };
}
