import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api.js";
import type { Part, System } from "./issue";

// The map's meaning in, the Blueprint's geometry out. ELK places parts inside their groups and routes the edges;
// nothing here is drawn by hand or by a model.

export type MapPart = Omit<Part, "box">;
export type MapGroup = { label: string; kind: "zone" | "frame"; members: string[]; parent?: string };
export type MapEdge = { from: string; to: string; label: string; dashed?: boolean };
export type SystemMap = { parts: MapPart[]; groups: MapGroup[]; edges: MapEdge[]; ignore?: string[] };

const MARGIN = 10;
const LABEL_H = 14;
// How big a part's box and an edge's label are; the Blueprint's by default, the Cutaway's at video size.
export type Measure = { node: (p: MapPart) => [w: number, h: number]; label: (text: string) => [w: number, h: number]; pad?: (g: MapGroup) => string };
const BLUEPRINT: Measure = {
  node: (p) => [Math.max(110, Math.max(p.name.length * 8.4, p.sub.length * 6.4) + 28), p.sub ? 50 : 32],
  label: (text) => [text.length * 6.2 + 6, LABEL_H],
};

export async function layout(map: SystemMap, options: Record<string, string> = {}, measure: Measure = BLUEPRINT): Promise<System> {
  const node = (id: string, p: MapPart) => {
    const [width, height] = measure.node(p);
    return { id, width, height };
  };
  const groupNode = new Map<string, ElkNode>();
  for (const g of map.groups) {
    groupNode.set(g.label, {
      id: `g:${g.label}`,
      layoutOptions: { "elk.padding": measure.pad?.(g) ?? `[top=${g.kind === "zone" ? 30 : 24},left=14,bottom=14,right=14]` },
      children: [],
    });
  }
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      // Top to bottom read best of the layouts tried on a real map: no wrap-around edges, flow from cloud to endpoint.
      "elk.direction": "DOWN",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "18",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      ...options,
    },
    children: [],
    edges: [],
  };
  const home = (label?: string) => (label ? (groupNode.get(label) as ElkNode) : root);
  for (const g of map.groups) home(g.parent).children?.push(groupNode.get(g.label) as ElkNode);
  const placed = new Set<string>();
  for (const g of map.groups)
    for (const id of g.members) {
      const p = map.parts.find((x) => x.id === id);
      if (!p || placed.has(id)) continue;
      placed.add(id);
      groupNode.get(g.label)?.children?.push(node(id, p));
    }
  for (const p of map.parts) if (!placed.has(p.id)) root.children?.push(node(p.id, p));
  root.edges = map.edges.map((e, i): ElkExtendedEdge => ({ id: `e${i}`, sources: [e.from], targets: [e.to], labels: [{ text: e.label, width: measure.label(e.label)[0], height: measure.label(e.label)[1] }] }));

  // Bun defines `self`, so ELK's bundled fallback thinks it is already in a worker; give it a real one.
  const elk = new ELK({ workerFactory: () => new Worker(Bun.resolveSync("elkjs/lib/elk-worker.min.js", import.meta.dir)) as never });
  const out = await elk.layout(root).finally(() => elk.terminateWorker());

  // ELK gives children relative to their parent; the Blueprint wants one coordinate space.
  const abs = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      abs.set(c.id, { x, y, w: c.width ?? 0, h: c.height ?? 0 });
      walk(c, x, y);
    }
  };
  walk(out, MARGIN, MARGIN);
  const box = (id: string): [number, number, number, number] => {
    const b = abs.get(id) as { x: number; y: number; w: number; h: number };
    return [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)];
  };
  // With INCLUDE_CHILDREN, edge sections are relative to the edge's container, which ELK reports per edge.
  const origin = (container?: string) => (container && container !== "root" ? (abs.get(container) ?? { x: MARGIN, y: MARGIN }) : { x: MARGIN, y: MARGIN });

  return {
    size: [Math.round((out.width ?? 0) + 2 * MARGIN), Math.round((out.height ?? 0) + 2 * MARGIN)],
    ...(map.ignore?.length ? { ignore: map.ignore } : {}),
    groups: map.groups.map((g) => ({ label: g.label, kind: g.kind, box: box(`g:${g.label}`), members: g.members, ...(g.parent ? { parent: g.parent } : {}) })),
    parts: map.parts.map((p) => ({ ...p, box: box(p.id) })),
    edges: (out.edges as (ElkExtendedEdge & { container?: string })[]).map((e, i) => {
      const o = origin(e.container);
      const s = e.sections?.[0];
      const pts = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
      const d = pts.map((p, k) => `${k ? "L" : "M"}${Math.round(o.x + p.x)},${Math.round(o.y + p.y)}`).join(" ");
      const l = e.labels?.[0];
      const at: [number, number] = l ? [Math.round(o.x + (l.x ?? 0) + (l.width ?? 0) / 2), Math.round(o.y + (l.y ?? 0) + (l.height ?? LABEL_H) - 3)] : [0, 0];
      return { d, label: map.edges[i].label, at, anchor: "middle" as const, from: map.edges[i].from, to: map.edges[i].to, ...(map.edges[i].dashed ? { dashed: true } : {}) };
    }),
  };
}

// The meaning of a map that was drawn by hand: a part belongs to the smallest group around its centre,
// a group sits in the smallest group around it, and an edge joins the parts nearest its two ends.
export function meaningOf(system: System): SystemMap {
  const inside = (b: number[], x: number, y: number) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
  const area = (b: number[]) => b[2] * b[3];
  const smallest = <T extends { box: number[] }>(xs: T[]) => xs.sort((a, b) => area(a.box) - area(b.box))[0];
  const groups: MapGroup[] = system.groups.map((g) => {
    const parent = smallest(system.groups.filter((o) => o !== g && area(o.box) > area(g.box) && inside(o.box, g.box[0] + 1, g.box[1] + 1)));
    const members = g.members ?? system.parts.filter((p) => smallest(system.groups.filter((o) => inside(o.box, p.box[0] + p.box[2] / 2, p.box[1] + p.box[3] / 2))) === g).map((p) => p.id);
    return { label: g.label, kind: g.kind, members, ...(parent ? { parent: parent.label } : {}) };
  });
  const nearest = (x: number, y: number) => {
    const dist = (b: number[]) => Math.hypot(Math.max(b[0] - x, 0, x - b[0] - b[2]), Math.max(b[1] - y, 0, y - b[1] - b[3]));
    return [...system.parts].sort((a, b) => dist(a.box) - dist(b.box))[0].id;
  };
  const edges: MapEdge[] = system.edges.map((e) => {
    const nums = [...e.d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => +m[0]);
    const start = [nums[0], nums[1]];
    // The end point: for H/V the last number is one coordinate; take it from the path's final command.
    const last = e.d.trim().split(/(?=[MLHVCSQTAZ])/i).at(-1) ?? "";
    const tail = [...last.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => +m[0]);
    const end = /^H/i.test(last) ? [tail[0], start[1]] : /^V/i.test(last) ? [start[0], tail[0]] : tail.slice(-2);
    return { from: e.from ?? nearest(start[0], start[1]), to: e.to ?? nearest(end[0], end[1]), label: e.label, ...(e.dashed ? { dashed: true } : {}) };
  });
  return { parts: system.parts.map(({ box: _, ...p }) => p), groups, edges, ...(system.ignore ? { ignore: system.ignore } : {}) };
}
