// The site: every project, each one's latest issue and archive, and the issues, read from the bucket publish writes.
// Read-only. It runs as the Cloudflare Worker (apps/worker) or wherever Bun runs (`daily-token serve`); each hands it a Store.
//
// Bucket layout:
//   projects.json                          [{ id, name }]
//   <project>/index.json                   [{ date, edition, headline }], newest first
//   <project>/issues/<date>/index.html     the rendered issue
//   <project>/issues/<date>/*.json         its data, stories, reels, motion
//   <project>/issues/<date>/motion.<hash>.* the Cutaway's video, poster and timing
//   static/<name>.<hash>.<ext>             pinned assets, shared, never overwritten

export type Range = { offset: number; length?: number } | { suffix: number };
export type Stored = { body: BodyInit; size: number; type?: string; etag?: string };
// get returns only the range's bytes when given one, and size is the whole object's.
export type Store = { get(key: string, range?: Range): Promise<Stored | null> };

type Entry = { date: string; edition: string; headline: string };
type Project = { id: string; name: string };

const PROJECT = /^\/([a-z0-9-]+)(\/.*)?$/;
const DATE = /^\/(\d{4}-\d{2}-\d{2})(\/.*)?$/;
// The motion's video and poster are named by their content, so they never change under that name.
const HASHED = /\/motion\.[0-9a-f]{10}\.(mp4|jpg|json)$/;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

// One range of bytes, as Safari asks to play a video. Several ranges, or none, get the whole object.
export function rangeOf(header: string | null): Range | undefined {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) return { suffix: Number(m[2]) };
  return m[2] ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : { offset: Number(m[1]) };
}

export function span(range: Range, size: number): { offset: number; length: number } {
  if ("suffix" in range) return { offset: Math.max(0, size - range.suffix), length: Math.min(range.suffix, size) };
  return { offset: range.offset, length: Math.min(range.length ?? size - range.offset, size - range.offset) };
}

async function serve(store: Store, key: string, cache: string, req?: Request): Promise<Response> {
  const range = rangeOf(req?.headers.get("range") ?? null);
  const obj = await store.get(key, range);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "cache-control": cache, "accept-ranges": "bytes" });
  if (obj.type) headers.set("content-type", obj.type);
  if (obj.etag) headers.set("etag", obj.etag);
  if (!range) return new Response(obj.body, { headers });
  const { offset, length } = span(range, obj.size);
  headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
  headers.set("content-length", String(length));
  return new Response(obj.body, { status: 206, headers });
}

async function json<T>(store: Store, key: string, empty: T): Promise<T> {
  const obj = await store.get(key);
  return obj ? ((await new Response(obj.body).json()) as T) : empty;
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

export async function site(req: Request, store: Store): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const { pathname } = new URL(req.url);
  const to = (path: string, status = 302) => Response.redirect(new URL(path, req.url).toString(), status);

  if (pathname.startsWith("/static/")) return serve(store, pathname.slice(1), "public, max-age=31536000, immutable");
  if (pathname === "/") {
    const projects = await json<Project[]>(store, "projects.json", []);
    return projects.length === 1 ? to(`/${projects[0].id}/`) : projectList(projects);
  }

  const p = PROJECT.exec(pathname);
  if (!p) return new Response("Not found", { status: 404 });
  const project = (await json<Project[]>(store, "projects.json", [])).find((x) => x.id === p[1]);
  if (!project) return new Response("Not found", { status: 404 });
  const rest = p[2] ?? "";

  if (rest === "") return to(`/${project.id}/`, 301);
  if (rest === "/") {
    const [latest] = await json<Entry[]>(store, `${project.id}/index.json`, []);
    return latest ? to(`/${project.id}/${latest.date}/`) : archive(project, []);
  }
  if (rest === "/archive") return archive(project, await json<Entry[]>(store, `${project.id}/index.json`, []));
  if (rest === "/index.json") return serve(store, `${project.id}/index.json`, "no-cache");

  const d = DATE.exec(rest);
  if (!d) return new Response("Not found", { status: 404 });
  if (!d[2]) return to(`/${project.id}/${d[1]}/`, 301);
  return serve(store, `${project.id}/issues/${d[1]}${d[2] === "/" ? "/index.html" : d[2]}`, HASHED.test(d[2]) ? "private, max-age=31536000, immutable" : "no-cache", req);
}
