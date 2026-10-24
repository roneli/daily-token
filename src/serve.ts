import { parseArgs } from "node:util";
import { bucket } from "./bucket";
import { door } from "./signin";
import { site, type Store, span } from "./site";

// The site, served from the issues bucket wherever Bun runs. With a GitHub App's settings in env, readers sign in
// with GitHub; without them it checks no one, so it serves only on this machine. deploy/cloudflare serves the same site.
const { values } = parseArgs({
  args: process.argv.slice(2),
  // --root comes from the CLI with every script; the site reads only the bucket.
  options: { port: { type: "string", default: process.env.PORT ?? "8787" }, host: { type: "string", default: "127.0.0.1" }, root: { type: "string" } },
});
const s3 = bucket();

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const open = !process.env.GITHUB_CLIENT_ID;
if (open && !LOOPBACK.has(values.host as string)) throw new Error(`serving on ${values.host} needs a sign-in: set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET (docs/deploy.md)`);
const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET } = process.env;
const gate = open ? undefined : door({ GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET });

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

const server = Bun.serve({ port: Number(values.port), hostname: values.host, fetch: (req) => site(req, store, { door: gate, domain: process.env.SITE_DOMAIN || undefined, home: process.env.HOME_KEY || undefined }) });
console.log(`serving the bucket on ${server.url}${open ? ", open to anyone on this machine" : ", signed in with GitHub"}`);
