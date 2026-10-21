import { describe, expect, test } from "bun:test";
import { scene } from "./scene";

const codes = (svg: string): string[] => scene(svg).errors.map((e) => e.code);

describe("scene", () => {
  test("passes shapes, text and marks", () => {
    const s = scene('<g id="r-a" class="box"><rect x="1" y="2" width="3" height="4" style="fill:var(--surface);stroke:var(--s1)"/><text x="5" y="6" data-anim="fade" data-at="300">hi &amp; bye</text></g><g data-cue="class" data-el="r-a" data-at="900" data-to="on"/>');
    expect(s.errors).toEqual([]);
    expect(s.ids).toEqual(["r-a"]);
    expect(s.text).toContain("hi & bye");
    expect(s.svg).toContain("&amp;");
  });

  test("lets an arrowhead take its line's color", () => {
    const s = scene('<defs><marker id="r-ah" viewBox="0 0 10 10" refX="10" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--muted);fill:context-stroke"/></marker></defs><line x1="0" y1="0" x2="9" y2="9" style="stroke:var(--bad)" marker-end="url(#r-ah)"/>');
    expect(s.errors).toEqual([]);
    expect(s.svg).toContain("context-stroke");
  });

  test("keeps case-sensitive SVG attributes", () => {
    const s = scene('<defs><marker id="r-m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--muted)"/></marker></defs><line x1="0" y1="0" x2="9" y2="9" marker-end="url(#r-m)" stroke="var(--ink)"/>');
    expect(s.errors).toEqual([]);
    expect(s.svg).toContain('viewBox="0 0 10 10"');
    expect(s.svg).toContain('refX="5"');
  });

  test("drops comments", () => {
    expect(scene("<g><!-- note --></g>").svg).toBe("<g/>");
  });

  test.each([
    ["script", "<script>alert(1)</script>", "tag"],
    ["foreignObject", "<foreignObject><div/></foreignObject>", "tag"],
    ["a link", '<a href="https://x.test"><text>x</text></a>', "tag"],
    ["image", '<image href="https://x.test/a.png"/>', "tag"],
    ["use", '<use href="#x"/>', "tag"],
    ["style element", "<style>*{}</style>", "tag"],
    ["event handler", '<rect onload="alert(1)"/>', "attr"],
    ["href", '<rect href="#x"/>', "attr"],
    ["external url", '<rect fill="url(https://x.test/a)"/>', "value"],
    ["external url in style", '<rect style="fill:url(https://x.test/a)"/>', "value"],
    ["css escape", '<rect style="fill:var(--\\61)"/>', "value"],
    ["raw hex", '<rect fill="#ff0000"/>', "color"],
    ["named color in style", '<rect style="stroke: red"/>', "color"],
    ["unknown mark", '<rect data-anim="spin"/>', "mark"],
    ["cdata", "<text><![CDATA[x]]></text>", "node"],
    ["processing instruction", '<?xml-stylesheet href="x.css"?><g/>', "node"],
  ])("refuses %s", (_name, svg, code) => {
    expect(codes(svg)).toContain(code);
  });

  test("refuses an oversized scene", () => {
    expect(codes("<g/>".repeat(401))).toContain("size");
  });
});
