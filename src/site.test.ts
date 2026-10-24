import { expect, test } from "bun:test";
import type { Door } from "./signin";
import { hostProject, rangeOf, type Store, site, span } from "./site";

const objects: Record<string, string> = {
  "projects.json": JSON.stringify([{ id: "rocket", name: "Rocket" }]),
  "rocket/index.json": JSON.stringify([{ date: "2026-01-15", edition: "daily", headline: "Lift-off" }]),
  "rocket/issues/2026-01-15/index.html": "<h1>Lift-off</h1>",
  "rocket/issues/2026-01-15/motion.0123456789.mp4": "0123456789",
  "rocket/issues/2026-01-15/preview.html": "<meta property=og:title>",
  "rocket/issues/2026-01-15/cover.0123456789.png": "png",
  "rocket/issues/2026-01-15/data.json": "{}",
};
const store: Store = {
  async get(key, range) {
    const body = objects[key];
    if (body === undefined) return null;
    const part = range && span(range, body.length);
    return { body: part ? body.slice(part.offset, part.offset + part.length) : body, size: body.length, type: "text/plain" };
  },
};
const get = (path: string, headers?: Record<string, string>) => site(new Request(`http://site${path}`, { headers }), store);

test("the only project opens on its latest issue", async () => {
  expect((await get("/")).headers.get("location")).toBe("http://site/rocket/");
  expect((await get("/rocket/")).headers.get("location")).toBe("http://site/rocket/2026-01-15/");
  expect(await (await get("/rocket/2026-01-15/")).text()).toBe("<h1>Lift-off</h1>");
});

test("an unknown project, date or file is not found, and only reads are allowed", async () => {
  expect((await get("/nope/")).status).toBe(404);
  expect((await get("/rocket/2026-01-16/")).status).toBe(404);
  expect((await get("/rocket/2026-01-15/secret.json")).status).toBe(404);
  expect((await site(new Request("http://site/", { method: "POST" }), store)).status).toBe(405);
});

test("a range gets its bytes, as Safari asks to play a video", async () => {
  const res = await get("/rocket/2026-01-15/motion.0123456789.mp4", { range: "bytes=2-5" });
  expect(res.status).toBe(206);
  expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(await res.text()).toBe("2345");
  expect(res.headers.get("cache-control")).toContain("immutable");
  expect(await (await get("/rocket/2026-01-15/motion.0123456789.mp4", { range: "bytes=-3" })).text()).toBe("789");
});

test("a range header is read as one span, or ignored", () => {
  expect(rangeOf("bytes=4-")).toEqual({ offset: 4 });
  expect(rangeOf("bytes=0-0,5-6")).toBeUndefined();
  expect(rangeOf("bytes=-")).toBeUndefined();
  expect(span({ suffix: 20 }, 10)).toEqual({ offset: 0, length: 10 });
});

// A door that lets anyone into a public project and a request carrying "reader" into any, and answers its own routes.
const door: Door = {
  reads: async (req, p) => p.access === "public" || req.headers.get("cookie") === "reader",
  auth: async () => new Response("auth"),
};
const gated = (path: string, cookie?: string) => site(new Request(`http://site${path}`, { headers: cookie ? { cookie } : {} }), store, { door });

test("without a sign-in, an issue's address shows its preview and cover, and nothing else of it", async () => {
  const preview = await gated("/rocket/2026-01-15/");
  expect(await preview.text()).toBe("<meta property=og:title>");
  expect(preview.headers.get("cache-control")).toBe("no-store");
  expect(await (await gated("/rocket/2026-01-15/cover.0123456789.png")).text()).toBe("png");
  for (const path of ["/rocket/2026-01-15/data.json", "/rocket/2026-01-15/index.html", "/rocket/2026-01-15/motion.0123456789.mp4", "/rocket/index.json"]) expect((await gated(path)).status).toBe(403);
  expect((await gated("/rocket/archive")).headers.get("location")).toBe("http://site/auth/github?to=%2Frocket%2Farchive");
  // An issue without a preview yet sends a reader to sign in.
  objects["rocket/index.json"] = JSON.stringify([{ date: "2026-01-16", edition: "daily", headline: "Orbit" }]);
  expect((await gated("/rocket/2026-01-16/")).headers.get("location")).toBe("http://site/auth/github?to=%2Frocket%2F2026-01-16%2F");
});

test("signed in, the issue is the page", async () => {
  expect(await (await gated("/rocket/2026-01-15/", "reader")).text()).toBe("<h1>Lift-off</h1>");
  expect(await (await gated("/rocket/2026-01-15/data.json", "reader")).text()).toBe("{}");
  expect((await gated("/auth/callback")).status).toBe(200);
  // Without a door the site has no sign-in routes.
  expect((await get("/auth/callback")).status).toBe(404);
});

test("the project list shows only what the visitor may read", async () => {
  objects["projects.json"] = JSON.stringify([{ id: "rocket", name: "Rocket" }, { id: "open", name: "Open", access: "public" }]);
  const list = await (await gated("/")).text();
  expect(list).toContain("Open");
  expect(list).not.toContain("Rocket");
  expect(await (await gated("/", "reader")).text()).toContain("Rocket");
  objects["projects.json"] = JSON.stringify([{ id: "rocket", name: "Rocket" }]);
});

test("a project's own host serves that project alone", async () => {
  objects["projects.json"] = JSON.stringify([{ id: "rocket", name: "Rocket" }, { id: "open", name: "Open", access: "public" }]);
  const at = (host: string, path: string) => site(new Request(`https://${host}${path}`), store, { domain: "digest.test" });
  expect((await at("rocket.digest.test", "/")).headers.get("location")).toBe("https://rocket.digest.test/rocket/");
  expect(await (await at("rocket.digest.test", "/rocket/2026-01-15/")).text()).toBe("<h1>Lift-off</h1>");
  expect((await at("rocket.digest.test", "/open/")).status).toBe(404);
  expect((await at("nope.digest.test", "/")).status).toBe(404);
  // Any other host is for every project.
  expect(await (await at("digest.test", "/")).text()).toContain("Open");
  expect(hostProject("a.b.digest.test", "digest.test")).toBe("a.b");
  expect(hostProject("rocket.digest.test")).toBeUndefined();
  objects["projects.json"] = JSON.stringify([{ id: "rocket", name: "Rocket" }]);
});

test("a public project reads without a sign-in", async () => {
  objects["projects.json"] = JSON.stringify([{ id: "rocket", name: "Rocket", access: "public" }]);
  expect(await (await gated("/rocket/2026-01-15/")).text()).toBe("<h1>Lift-off</h1>");
  expect(await (await gated("/rocket/2026-01-15/data.json")).text()).toBe("{}");
  objects["projects.json"] = JSON.stringify([{ id: "rocket", name: "Rocket" }]);
});
