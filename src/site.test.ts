import { expect, test } from "bun:test";
import { rangeOf, type Store, site, span } from "./site";

const objects: Record<string, string> = {
  "projects.json": JSON.stringify([{ id: "rocket", name: "Rocket" }]),
  "rocket/index.json": JSON.stringify([{ date: "2026-01-15", edition: "daily", headline: "Lift-off" }]),
  "rocket/issues/2026-01-15/index.html": "<h1>Lift-off</h1>",
  "rocket/issues/2026-01-15/motion.0123456789.mp4": "0123456789",
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
