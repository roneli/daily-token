// The site on Cloudflare: the bucket bound as R2, every request signed by Access. Optional: `daily-token serve` runs the same site anywhere.

/// <reference types="@cloudflare/workers-types" />

import { site, type Store } from "../../../src/site";
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
    return (await denied(req, env)) ?? site(req, r2(env.ISSUES));
  },
};
