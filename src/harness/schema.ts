import { join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { ENGINE, readJson } from "../issue";

// One Ajv for the process. Every schema compiles once: check and the agents' answers run after every attempt.
const ajv = new Ajv({ allErrors: true });
const compiled = new WeakMap<object, ValidateFunction>();
const loaded = new Map<string, Promise<object>>();

export function compile(schema: object): ValidateFunction {
  let fn = compiled.get(schema);
  if (!fn) {
    const id = (schema as { $id?: string }).$id;
    const known = id ? ajv.getSchema(id) : undefined;
    // Two different schemas under one $id would validate against whichever came first.
    if (known && JSON.stringify(known.schema) !== JSON.stringify(schema)) throw new Error(`two different schemas have $id "${id}"`);
    fn = known || ajv.compile(schema);
    compiled.set(schema, fn);
  }
  return fn;
}

// Errors as one line each: "<name><path> <message>".
export function errorsOf(schema: object, value: unknown, name = ""): string[] {
  const fn = compile(schema);
  return fn(value) ? [] : (fn.errors ?? []).map((e) => `${name}${e.instancePath || (name ? "" : "/")} ${e.message}`);
}

// An agent's output schema, from its folder.
export const agentSchema = (agent: string) => load(join(ENGINE, "agents", agent, "output.schema.json"));

// A schema file, read once. A path is absolute, or relative to the engine's schemas/ ("reels").
export function load(path: string): Promise<object> {
  const file = path.startsWith("/") ? path : join(ENGINE, "schemas", `${path}.schema.json`);
  let p = loaded.get(file);
  if (!p) {
    p = readJson<object>(file).then((s) => inline(s) as Promise<object>);
    loaded.set(file, p);
  }
  return p;
}

// The claude CLI takes one self-contained schema, so a ref to another file ("reels#/properties/reels") is copied in.
// Only refs within the same file ("#/definitions/x") stay refs, and a copied fragment may not hold any.
async function inline(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(inline));
  if (!node || typeof node !== "object") return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === "string" && !ref.startsWith("#")) {
    const [id, pointer = ""] = ref.split("#");
    let target: unknown = await readJson<object>(join(ENGINE, "schemas", `${id}.schema.json`));
    for (const key of pointer.split("/").filter(Boolean)) target = (target as Record<string, unknown>)[key];
    if (target === undefined) throw new Error(`schema ref ${ref} points at nothing`);
    if (JSON.stringify(target).includes('"$ref":"#')) throw new Error(`schema ref ${ref} copies a fragment with refs of its own`);
    const { $id: _id, $schema: _schema, ...rest } = target as Record<string, unknown>;
    return inline(rest);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = await inline(v);
  return out;
}
