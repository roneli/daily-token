import { expect, test } from "bun:test";
import { layout, wrap } from "./sequence.layout";

test("wrap splits into two balanced lines and leaves short text alone", () => {
  expect(wrap("after checking the reader's pid", 28)).toEqual(["after checking", "the reader's pid"]);
  expect(wrap("freeze", 28)).toEqual(["freeze"]);
});

test("a set that can't fit the frame is refused", () => {
  const msg = { from: 0, to: 1, label: "a label long enough to wrap onto two lines", label2: "and a second label that wraps too", tone: "ink", tag: "before" };
  expect(() => layout({ actors: [{ name: "A" }, { name: "B" }, { name: "C" }], messages: Array(6).fill(msg) })).toThrow(/px of height/);
});

test("a result goes past the arrowhead, or under the arrow, never on the lifeline", () => {
  const out = layout({ actors: [{ name: "A" }, { name: "B" }], messages: [{ from: 1, to: 0, label: "no", tone: "bad", result: { text: "✓ a long result here", tone: "good" } }] });
  const m = (out.fields.messages as { resultPos: { x: number; anchor: string; below: boolean } }[])[0];
  expect(m.resultPos.below).toBe(true);
  expect(m.resultPos.x).toBeGreaterThan(120);
});
