import { expect, test } from "bun:test";
import { compile, errorsOf, load } from "./schema";

test("a schema file is read and compiled once", async () => {
  const a = await load("stories");
  expect(await load("stories")).toBe(a);
  expect(compile(a)).toBe(compile(a));
});

test("errors name the value and the path", async () => {
  const errors = errorsOf(await load("project"), { id: "Bad Id", name: "x", repos: [] }, "project");
  expect(errors.some((e) => e.startsWith("project/id "))).toBe(true);
});

test("a schema with the $id of one already compiled reuses it", async () => {
  const stories = await load("stories");
  expect(compile({ ...stories })).toBe(compile(stories));
});

test("a ref to another schema file is copied in, without its $id", async () => {
  const [director, reels] = await Promise.all([load("agents/director"), load("reels")]);
  const prop = (s: object, k: string) => (s as { properties: Record<string, unknown> }).properties[k];
  expect(prop(director, "reels")).toEqual(prop(reels, "reels"));
  expect(JSON.stringify(director)).not.toContain('"$ref":"');
  expect(JSON.stringify(director)).not.toContain('"$id"');
});

test("every agent schema compiles", async () => {
  for (const name of ["director", "cartographer"]) expect(typeof compile(await load(`agents/${name}`))).toBe("function");
});

test("a whole schema copied in by ref loses its $id", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const file = `${await mkdtemp(`${tmpdir()}/schema-`)}/wrap.schema.json`;
  await Bun.write(file, JSON.stringify({ type: "object", properties: { stories: { $ref: "stories" } } }));
  const wrap = (await load(file)) as { properties: { stories: Record<string, unknown> } };
  const { $id: _id, ...plain } = (await load("stories")) as Record<string, unknown>;
  expect(wrap.properties.stories).toEqual(plain);
  expect(compile(wrap)({ stories: {} })).toBe(false);
});

test("two different schemas under one $id are refused", () => {
  compile({ $id: "clash-test", type: "string" });
  expect(() => compile({ $id: "clash-test", type: "number" })).toThrow('two different schemas have $id "clash-test"');
});
