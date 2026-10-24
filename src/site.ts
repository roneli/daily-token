// The site: every project, each one's latest issue and archive, and the issues, read from the bucket publish writes.
// Read-only. It runs as the Cloudflare Worker (deploy/cloudflare) or wherever Bun runs (`daily-token serve`); each hands it a Store,
// and a Door unless the site is open. Without a sign-in, an issue's address answers with its preview and its cover, so a
// link unfurls wherever it's shared; the rest of a project that isn't public stays shut. With a domain, each project
// also has its own host, <id>.<domain>, which serves that project alone. Any other host serves the bucket's home page
// (home/), when it has one, at / or, with a key, only at /<key>/.
//
// Bucket layout:
//   projects.json                          [{ id, name, access }]
//   <project>/index.json                   [{ date, edition, headline }], newest first
//   <project>/issues/<date>/index.html     the rendered issue
//   <project>/issues/<date>/preview.html   its preview, and cover.<hash>.png
//   <project>/issues/<date>/*.json         its data, stories, reels, motion
//   <project>/issues/<date>/motion.<hash>.* the Cutaway's video, poster and timing
//   static/<name>.<hash>.<ext>             pinned assets, shared, never overwritten
//   home/index.html, home/<file>           optional: the site's own home page, from `daily-token home`

import { type Door, type Listed, signInPath } from "./signin";

export type Range = { offset: number; length?: number } | { suffix: number };
export type Stored = { body: BodyInit; size: number; type?: string; etag?: string };
// get returns only the range's bytes when given one, and size is the whole object's.
export type Store = { get(key: string, range?: Range): Promise<Stored | null> };

type Entry = { date: string; edition: string; headline: string };

const PROJECT = /^\/([a-z0-9-]+)(\/.*)?$/;
const DATE = /^\/(\d{4}-\d{2}-\d{2})(\/.*)?$/;
// The motion's video and poster are named by their content, so they never change under that name.
const HASHED = /\/motion\.[0-9a-f]{10}\.(mp4|jpg|json)$/;
// A home page's file: one name with a dot, which no project id has.
const HOME_FILE = /^\/([\w-]+\.[\w.]+)$/;
const COVER = /^\/cover\.[0-9a-f]{10}\.png$/;

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

const projectList = (projects: Listed[]) =>
  page("The Daily Token", "Every project.", projects.map((p) => `<li><a href="/${p.id}/">${escapeHtml(p.name)}</a></li>`).join(""));

const archive = (project: Listed, entries: Entry[]) =>
  page(
    `The Daily Token · ${project.name}`,
    "Every issue, newest first.",
    entries.map((e) => `<li><a href="/${project.id}/${e.date}/"><span>${e.date}</span>${e.edition === "weekly" ? " <b>Weekly edition</b>" : ""}<br>${escapeHtml(e.headline)}</a></li>`).join(""),
  );

export type Options = { door?: Door; domain?: string; home?: string };

// The project a host is for, as <id>.<domain>; any other host is for every project. A name may end in a dot.
export function hostProject(hostname: string, domain?: string): string | undefined {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!domain || !host.endsWith(`.${domain}`)) return undefined;
  return host.slice(0, -domain.length - 1);
}

// The home page and its files, at / or under /<key>/; null when this isn't one of them or the bucket has none.
async function homePage(store: Store, pathname: string, key?: string): Promise<Response | null> {
  const base = key ? `/${key}` : "";
  if (!pathname.startsWith(`${base}/`)) return null;
  const rest = pathname.slice(base.length);
  const file = rest === "/" ? "index.html" : HOME_FILE.exec(rest)?.[1];
  if (!file) return null;
  const res = await serve(store, `home/${file}`, "no-cache");
  if (!res.ok) return null;
  // Not for search engines while it hides behind a key.
  if (key) res.headers.set("x-robots-tag", "noindex, nofollow");
  return res;
}

export async function site(req: Request, store: Store, { door, domain, home }: Options = {}): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const { pathname, hostname } = url;
  // A host may be written with a final dot. One name only, so sign-in returns where GitHub expects and cookies match.
  if (hostname.endsWith(".")) {
    url.hostname = hostname.replace(/\.+$/, "");
    return Response.redirect(url.toString(), 301);
  }
  const own = hostProject(hostname, domain);
  const to = (path: string, status = 302) => Response.redirect(new URL(path, req.url).toString(), status);
  const shut = () => new Response("Forbidden", { status: 403 });

  if (pathname.startsWith("/static/")) return serve(store, pathname.slice(1), "public, max-age=31536000, immutable");
  if (own === undefined) {
    const shown = await homePage(store, pathname, home);
    if (shown) return shown;
    // Behind a key, the home page's host shows nothing else at its root.
    if (home && pathname === "/" && (await store.get("home/index.html"))) return new Response("Not found", { status: 404 });
  }
  const listed = await json<Listed[]>(store, "projects.json", []);
  const projects = own === undefined ? listed : listed.filter((p) => p.id === own);
  if (own !== undefined && !projects.length) return new Response("Not found", { status: 404 });
  if (pathname.startsWith("/auth/")) return door ? door.auth(req, projects) : new Response("Not found", { status: 404 });
  const reads = async (project: Listed) => !door || (await door.reads(req, project));
  if (pathname === "/") {
    if (projects.length === 1) return to(`/${projects[0].id}/`);
    const shown = [];
    for (const p of projects) if (await reads(p)) shown.push(p);
    return projectList(shown);
  }

  const p = PROJECT.exec(pathname);
  if (!p) return new Response("Not found", { status: 404 });
  const project = projects.find((x) => x.id === p[1]);
  if (!project) return new Response("Not found", { status: 404 });
  const rest = p[2] ?? "";
  const open = await reads(project);

  if (rest === "") return to(`/${project.id}/`, 301);
  if (rest === "/") {
    const [latest] = await json<Entry[]>(store, `${project.id}/index.json`, []);
    return latest ? to(`/${project.id}/${latest.date}/`) : open ? archive(project, []) : to(signInPath(`/${project.id}/`));
  }
  if (rest === "/archive") return open ? archive(project, await json<Entry[]>(store, `${project.id}/index.json`, [])) : to(signInPath(`/${project.id}/archive`));
  if (rest === "/index.json") return open ? serve(store, `${project.id}/index.json`, "private, no-cache") : shut();

  const d = DATE.exec(rest);
  if (!d) return new Response("Not found", { status: 404 });
  if (!d[2]) return to(`/${project.id}/${d[1]}/`, 301);
  const dir = `${project.id}/issues/${d[1]}`;
  if (COVER.test(d[2])) return serve(store, `${dir}${d[2]}`, "public, max-age=31536000, immutable");
  if (!open) {
    if (d[2] !== "/") return shut();
    const preview = await serve(store, `${dir}/preview.html`, "no-store");
    return preview.ok ? preview : to(signInPath(`/${project.id}/${d[1]}/`));
  }
  return serve(store, `${dir}${d[2] === "/" ? "/index.html" : d[2]}`, HASHED.test(d[2]) ? "private, max-age=31536000, immutable" : "private, no-cache", req);
}
