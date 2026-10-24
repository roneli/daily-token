import { readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { $ } from "bun";
import { ENGINE } from "./issue";

const args = process.argv.slice(2);
await $`bun ${join(ENGINE, "src", "render.ts")} --all ${args}`;

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const latest = async (project: string) => (await readdir(join("out", project))).filter(isDate).sort().at(-1);

const serve = (port: number) => Bun.serve({
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
    // A share link, as the site serves it: the issue's share page.
    const share = /^\/share\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})\/(cover\.[0-9a-f]{10}\.png)?$/.exec(path);
    if (share) path = `/${share[1]}/${share[2]}/${share[3] ?? "share.html"}`;
    else if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join("out", path));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});

// Another preview may hold the port, maybe of another root: take the next free one.
const first = Number(process.env.PORT ?? 5173);
let server: ReturnType<typeof serve> | undefined;
for (let port = first; !server; port++) {
  try {
    server = serve(port);
  } catch (e) {
    if ((e as { code?: string }).code !== "EADDRINUSE" || port > first + 20) throw e;
  }
}
if (server.port !== first) console.log(`port ${first} is taken, maybe by another preview`);
console.log(`preview on http://localhost:${server.port}/`);
