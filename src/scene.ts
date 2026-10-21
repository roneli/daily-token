import render from "dom-serializer";
import { type ChildNode, isTag, isText } from "domhandler";
import { parseDocument } from "htmlparser2";

// A scene is a reel the Director draws itself: the inside of a 640×360 SVG, with animation marks.
// It is checked against an allowlist and re-serialized from the parsed tree, so the page carries only what passed.

const TAGS = new Set(["g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title", "defs", "marker", "linearGradient", "radialGradient", "stop"]);

const ATTRS = new Set([
  "id", "class", "style", "transform", "opacity",
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-opacity",
  "marker-start", "marker-mid", "marker-end",
  "font-size", "font-weight", "text-anchor", "dominant-baseline", "letter-spacing",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "d", "points", "dx", "dy", "pathLength",
  "viewBox", "refX", "refY", "markerWidth", "markerHeight", "markerUnits", "orient",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "data-anim", "data-cue", "data-el", "data-at", "data-ms", "data-from", "data-to", "data-x", "data-y", "data-prefix", "data-suffix",
]);

const MARKS = new Set(["fade", "out", "drop", "grow", "class", "text", "count", "width", "move", "type", "draw"]);
const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color", "color"]);
// context-stroke and context-fill paint a marker in its line's own color.
const COLOR = /^(none|currentColor|transparent|context-stroke|context-fill|var\(--[\w-]+\)|url\(#[\w-]+\))$/;
const MAX_NODES = 400;

export type SceneError = { code: "node" | "tag" | "attr" | "value" | "color" | "mark" | "size"; detail: string };

function checkValue(name: string, value: string, errors: SceneError[]) {
  if (/javascript:|expression\(|@import|\\/i.test(value)) errors.push({ code: "value", detail: `${name}="${value}"` });
  for (const m of value.matchAll(/url\(([^)]*)\)/gi)) if (!/^#[\w-]+$/.test(m[1].trim())) errors.push({ code: "value", detail: `${name} points outside the scene: url(${m[1]})` });
  if (COLOR_ATTRS.has(name) && !COLOR.test(value.trim())) errors.push({ code: "color", detail: `${name}="${value}": use a var(--token) so dark mode works` });
  if (name === "style")
    for (const decl of value.split(";")) {
      const [prop, ...rest] = decl.split(":");
      const p = prop?.trim().toLowerCase();
      if (p && COLOR_ATTRS.has(p) && !COLOR.test(rest.join(":").trim())) errors.push({ code: "color", detail: `style ${p}:${rest.join(":")}: use a var(--token) so dark mode works` });
    }
  if ((name === "data-anim" || name === "data-cue") && !MARKS.has(value)) errors.push({ code: "mark", detail: `${name}="${value}" isn't a mark` });
}

export function scene(svg: string) {
  const doc = parseDocument(svg, { xmlMode: true });
  const errors: SceneError[] = [];
  const ids: string[] = [];
  const text: string[] = [];
  let nodes = 0;

  const walk = (children: ChildNode[]): ChildNode[] =>
    children.filter((n) => {
      nodes++;
      if (isText(n)) {
        text.push(n.data);
        return true;
      }
      if (n.type === "comment") return false;
      if (!isTag(n)) {
        errors.push({ code: "node", detail: `a ${n.type} node` });
        return false;
      }
      if (!TAGS.has(n.name)) errors.push({ code: "tag", detail: `<${n.name}>` });
      for (const [name, value] of Object.entries(n.attribs)) {
        if (!ATTRS.has(name)) errors.push({ code: "attr", detail: `<${n.name} ${name}>` });
        else checkValue(name, value, errors);
        if (name === "id") ids.push(value);
      }
      n.children = walk(n.children);
      return true;
    });

  doc.children = walk(doc.children);
  if (nodes > MAX_NODES) errors.push({ code: "size", detail: `${nodes} nodes; a scene has at most ${MAX_NODES}` });
  return { svg: render(doc, { xmlMode: true }), errors, ids, text: text.join(" ") };
}
