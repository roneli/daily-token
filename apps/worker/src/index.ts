// Serves rendered issues from R2. Read-only: the GitHub Action is the only writer.
//
// R2 layout:
//   projects.json                          [{ id, name }]
//   <project>/index.json                   [{ date, edition, headline }], newest first
//   <project>/issues/<date>/index.html     the rendered issue
//   <project>/issues/<date>/*.json         its data, stories, reels, motion
//   <project>/issues/<date>/motion.<hash>.* the Cutaway's video, poster and timing
//   static/<name>.<hash>.<ext>             pinned assets, shared, never overwritten

/// <reference types="@cloudflare/workers-types" />

import { type AccessEnv, denied } from "./access";

type Env = AccessEnv & { ISSUES: R2Bucket };
type Entry = { date: string; edition: string; headline: string };
type Project = { id: string; name: string };

const PROJECT = /^\/([a-z0-9-]+)(\/.*)?$/;
const DATE = /^\/(\d{4}-\d{2}-\d{2})(\/.*)?$/;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

// A request with a Range header gets that part: Safari plays a video only from ranges.
async function serve(env: Env, key: string, cache: string, req?: Request): Promise<Response> {
  const ranged = req?.headers.has("range");
  const obj = await env.ISSUES.get(key, ranged ? { range: req?.headers } : undefined);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "cache-control": cache, "accept-ranges": "bytes" });
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (!ranged || !r) return new Response(obj.body, { headers });
  const offset = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
  const length = r.suffix ?? r.length ?? obj.size - offset;
  headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
  headers.set("content-length", String(length));
  return new Response(obj.body, { status: 206, headers });
}

// The motion's video and poster are named by their content, so they never change under that name.
const HASHED = /\/motion\.[0-9a-f]{10}\.(mp4|jpg|json)$/;

async function json<T>(env: Env, key: string, empty: T): Promise<T> {
  const obj = await env.ISSUES.get(key);
  return obj ? ((await obj.json()) as T) : empty;
}

function page(title: string, intro: string, rows: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px}h1{font-size:28px}ul{list-style:none;padding:0;display:grid;gap:10px}a{display:block;padding:12px 14px;border:1px solid #8884;border-radius:10px;text-decoration:none;color:inherit}span{font-family:ui-monospace,monospace;opacity:.7}</style>
<h1>${escapeHtml(title)}</h1><p>${intro}</p><ul>${rows}</ul>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

const projectList = (projects: Project[]) =>
  page("The Daily Token", "Every project.", projects.map((p) => `<li><a href="/${p.id}/">${escapeHtml(p.name)}</a></li>`).join(""));

const archive = (project: Project, entries: Entry[]) =>
  page(
    `The Daily Token · ${project.name}`,
    "Every issue, newest first.",
    entries.map((e) => `<li><a href="/${project.id}/${e.date}/"><span>${e.date}</span>${e.edition === "thursday" ? " <b>Thursday edition</b>" : ""}<br>${escapeHtml(e.headline)}</a></li>`).join(""),
  );

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const refused = await denied(req, env);
    if (refused) return refused;
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const { pathname } = new URL(req.url);
    const to = (path: string, status = 302) => Response.redirect(new URL(path, req.url).toString(), status);

    if (pathname.startsWith("/static/")) return serve(env, pathname.slice(1), "public, max-age=31536000, immutable");
    if (pathname === "/") {
      const projects = await json<Project[]>(env, "projects.json", []);
      return projects.length === 1 ? to(`/${projects[0].id}/`) : projectList(projects);
    }

    const p = PROJECT.exec(pathname);
    if (!p) return new Response("Not found", { status: 404 });
    const project = (await json<Project[]>(env, "projects.json", [])).find((x) => x.id === p[1]);
    if (!project) return new Response("Not found", { status: 404 });
    const rest = p[2] ?? "";

    if (rest === "") return to(`/${project.id}/`, 301);
    if (rest === "/") {
      const [latest] = await json<Entry[]>(env, `${project.id}/index.json`, []);
      return latest ? to(`/${project.id}/${latest.date}/`) : archive(project, []);
    }
    if (rest === "/archive") return archive(project, await json<Entry[]>(env, `${project.id}/index.json`, []));
    if (rest === "/index.json") return serve(env, `${project.id}/index.json`, "no-cache");

    const d = DATE.exec(rest);
    if (!d) return new Response("Not found", { status: 404 });
    if (!d[2]) return to(`/${project.id}/${d[1]}/`, 301);
    return serve(env, `${project.id}/issues/${d[1]}${d[2] === "/" ? "/index.html" : d[2]}`, HASHED.test(d[2]) ? "private, max-age=31536000, immutable" : "no-cache", req);
  },
};
