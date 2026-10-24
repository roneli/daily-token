// The site on Cloudflare: the bucket bound as R2, readers signed in with GitHub. Optional: `daily-token serve` runs the same site anywhere.

/// <reference types="@cloudflare/workers-types" />

import { site, type Store } from "../../../src/site";
import { door, type SignInEnv } from "../../../src/signin";

type Env = SignInEnv & { ISSUES: R2Bucket };

const LOCAL = new Set(["localhost", "127.0.0.1"]);

const r2 = (bucket: R2Bucket): Store => ({
  async get(key, range) {
    const obj = await bucket.get(key, range ? { range } : undefined);
    return obj && { body: obj.body, size: obj.size, type: obj.httpMetadata?.contentType, etag: obj.httpEtag };
  },
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // `wrangler dev` without a GitHub App is open; deployed, the Worker answers only for its domain, never localhost.
    const open = LOCAL.has(new URL(req.url).hostname) && !env.GITHUB_CLIENT_ID;
    return site(req, r2(env.ISSUES), open ? undefined : door(env));
  },
};
