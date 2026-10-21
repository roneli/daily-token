import { expect, test } from "bun:test";
import { layout } from "./stack.layout";

test("named queue items get a box each with the name in it; a bare count gets empty ones", () => {
  const named = layout({ bars: [], queue: { items: ["#432", "#288"], label: "2 open" } }).fields.boxes;
  expect(named.map((b) => b.name)).toEqual(["#432", "#288"]);
  expect(named[1].x).toBeGreaterThan(named[0].x + named[0].w);
  const counted = layout({ bars: [], queue: { count: 3, label: "3 open" } }).fields.boxes;
  expect(counted.map((b) => b.name)).toEqual(["", "", ""]);
});
