import { parseArgs } from "node:util";
import { bucket } from "./bucket";
import { site, type Store, span } from "./site";

// The site, served from the issues bucket wherever Bun runs. It checks no one: keep it on localhost,
// or put it behind your own sign-in. On Cloudflare, deploy/cloudflare serves the same site behind Access.
const { values } = parseArgs({
  args: process.argv.slice(2),
  // --root comes from the CLI with every script; the site reads only the bucket.
  options: { port: { type: "string", default: process.env.PORT ?? "8787" }, host: { type: "string", default: "127.0.0.1" }, root: { type: "string" } },
});
const s3 = bucket();

const missing = (e: unknown) => ["NoSuchKey", "NotFound"].includes((e as { code?: string }).code ?? "");

const store: Store = {
  async get(key, range) {
    const file = s3.file(key);
    const stat = await file.stat().catch((e) => {
      if (missing(e)) return null;
      throw e;
    });
    if (!stat) return null;
    const part = range && span(range, stat.size);
    // A stream, not the S3File: Bun answers a Response made from an S3File differently.
    return { body: (part ? file.slice(part.offset, part.offset + part.length) : file).stream(), size: stat.size, type: stat.type, etag: stat.etag };
  },
};

const server = Bun.serve({ port: Number(values.port), hostname: values.host, fetch: (req) => site(req, store) });
console.log(`serving the bucket on ${server.url}`);
