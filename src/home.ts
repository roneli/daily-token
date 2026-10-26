import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bucket } from "./bucket";

// home: a folder's files become the bare domain's front page, home/ in the bucket: index.html and what it links to,
// side by side, no subfolders. With HOME_PROJECT set, the bare domain shows it to that project's readers. Files no
// longer in the folder go.
const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { root: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
const dir = positionals[0];
if (!dir) throw new Error("daily-token home DIR: the folder with index.html");
// The page's own files: notes beside it (README.md, a design record) stay out.
const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && /^[\w-]+\.[\w.]+$/.test(e.name) && !e.name.endsWith(".md")).map((e) => e.name);
if (!names.includes("index.html")) throw new Error(`${dir} has no index.html`);
const dry = values["dry-run"] as boolean;
const s3 = bucket();
for (const name of names) {
  console.log(`${dry ? "would put" : "put"} home/${name}`);
  if (!dry) await s3.write(`home/${name}`, Bun.file(join(dir, name)), { type: Bun.file(name).type });
}
const held = (await s3.list({ prefix: "home/" })).contents ?? [];
for (const o of held)
  if (!names.includes(o.key.slice("home/".length))) {
    console.log(`${dry ? "would remove" : "remove"} ${o.key}`);
    if (!dry) await s3.delete(o.key);
  }
