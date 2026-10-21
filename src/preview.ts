import { readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { $ } from "bun";
import { ENGINE } from "./issue";

const port = Number(process.env.PORT ?? 5173);
const args = process.argv.slice(2);
await $`bun ${join(ENGINE, "src", "render.ts")} --all ${args}`;

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const latest = async (project: string) => (await readdir(join("out", project))).filter(isDate).sort().at(-1);

Bun.serve({
  port,
  async fetch(req) {
    let path = normalize(decodeURIComponent(new URL(req.url).pathname));
    if (path.includes("..")) return new Response("Not found", { status: 404 });
    const segs = path.split("/").filter(Boolean);
    if (segs.length === 0) {
      const project = (await readdir("out")).find((d) => d !== "static" && !d.includes("."));
      return Response.redirect(`/${project}/${await latest(project ?? "")}/`, 302);
    }
    if (segs.length === 1 && segs[0] !== "static") return Response.redirect(`/${segs[0]}/${await latest(segs[0])}/`, 302);
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join("out", path));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
console.log(`preview on http://localhost:${port}/`);
