// Cloudflare Access signs every request it lets through. The Worker refuses anything unsigned,
// so a gap in the Access policy or a stray route can't expose an issue.

import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export type AccessEnv = { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string };

const LOCAL = new Set(["localhost", "127.0.0.1"]);
let remote: JWTVerifyGetKey | undefined;

const forbidden = () => new Response("Forbidden", { status: 403 });

export async function denied(req: Request, env: AccessEnv, keys?: JWTVerifyGetKey): Promise<Response | null> {
  if (LOCAL.has(new URL(req.url).hostname)) return null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return forbidden();
  try {
    remote ??= createRemoteJWKSet(new URL("/cdn-cgi/access/certs", env.ACCESS_TEAM_DOMAIN));
    await jwtVerify(token, keys ?? remote, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
    return null;
  } catch {
    return forbidden();
  }
}
