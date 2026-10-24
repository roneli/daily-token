// The site on Cloudflare: the bucket bound as R2, every request signed by Access but a share link's. Optional: `daily-token serve` runs the same site anywhere.

/// <reference types="@cloudflare/workers-types" />

import { isShare, site, type Store } from "../../../src/site";
import { type AccessEnv, denied } from "./access";

type Env = AccessEnv & { ISSUES: R2Bucket };

const r2 = (bucket: R2Bucket): Store => ({
  async get(key, range) {
    const obj = await bucket.get(key, range ? { range } : undefined);
    return obj && { body: obj.body, size: obj.size, type: obj.httpMetadata?.contentType, etag: obj.httpEtag };
  },
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // A share link's preview page and cover are public (Access bypasses /share/ too); everything else is signed.
    if (isShare(new URL(req.url).pathname)) return site(req, r2(env.ISSUES));
    return (await denied(req, env)) ?? site(req, r2(env.ISSUES));
  },
};
