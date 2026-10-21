import { expect, test } from "bun:test";
import type { System } from "./issue";
import { layout, meaningOf } from "./layout";

const drawn = {
  size: [400, 200],
  groups: [
    { label: "Ground", kind: "zone", box: [0, 0, 200, 200] },
    { label: "Pad", kind: "frame", box: [10, 20, 120, 100] },
    { label: "Sky", kind: "zone", box: [220, 0, 180, 200] },
  ],
  parts: [
    { id: "clamp", name: "Clamp", sub: "", what: "", box: [20, 40, 80, 30] },
    { id: "tower", name: "Tower", sub: "", what: "", box: [20, 150, 80, 30] },
    { id: "rocket", name: "Rocket", sub: "stages", what: "", box: [240, 40, 120, 50] },
  ],
  edges: [
    { d: "M100,55 H240", label: "releases", at: [170, 50] },
    { d: "M60,150 V70", label: "holds", at: [64, 110], dashed: true },
  ],
} as unknown as System;

test("a drawn map's meaning: members, nesting and edge ends come from the geometry", () => {
  const m = meaningOf(drawn);
  expect(m.groups).toEqual([
    { label: "Ground", kind: "zone", members: ["tower"] },
    { label: "Pad", kind: "frame", members: ["clamp"], parent: "Ground" },
    { label: "Sky", kind: "zone", members: ["rocket"] },
  ]);
  expect(m.edges).toEqual([
    { from: "clamp", to: "rocket", label: "releases" },
    { from: "tower", to: "clamp", label: "holds", dashed: true },
  ]);
});

test("the layout boxes every part inside its group and routes every edge", async () => {
  const out = await layout(meaningOf(drawn));
  const box = (id: string) => out.parts.find((p) => p.id === id)?.box as number[];
  const group = (label: string) => out.groups.find((g) => g.label === label)?.box as number[];
  const within = (b: number[], g: number[]) => b[0] >= g[0] && b[1] >= g[1] && b[0] + b[2] <= g[0] + g[2] && b[1] + b[3] <= g[1] + g[3];
  expect(within(box("clamp"), group("Pad"))).toBe(true);
  expect(within(group("Pad"), group("Ground"))).toBe(true);
  expect(within(box("rocket"), group("Sky"))).toBe(true);
  for (const e of out.edges) expect(e.d).toMatch(/^M\d+,\d+( L\d+,\d+)+$/);
  expect(out.edges[1].dashed).toBe(true);
});
