import { beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import { denied } from "./access";

const env = { ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.test", ACCESS_AUD: "app-aud" };
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let keys: JWTVerifyGetKey;
let signer: Key;
let stranger: Key;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signer = pair.privateKey;
  stranger = (await generateKeyPair("RS256")).privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
});

const token = (claims: { iss?: string; aud?: string; exp?: string } = {}, key = signer) =>
  new SignJWT({ email: "reader@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(claims.aud ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "1h")
    .sign(key);

const request = (jwt?: string, host = "digest.example.test") =>
  new Request(`https://${host}/p/`, { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });

const status = async (req: Request, e = env) => (await denied(req, e, keys))?.status ?? 200;

describe("access", () => {
  test("lets a signed request through", async () => {
    expect(await status(request(await token()))).toBe(200);
  });

  test("lets local dev through without a token", async () => {
    expect(await status(request(undefined, "localhost"))).toBe(200);
  });

  test("fails closed when not configured", async () => {
    expect(await status(request(await token()), { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" })).toBe(503);
  });

  test.each([
    ["no token", async () => undefined],
    ["garbage", async () => "not.a.jwt"],
    ["another app", () => token({ aud: "other-aud" })],
    ["another team", () => token({ iss: "https://evil.cloudflareaccess.test" })],
    ["expired", () => token({ exp: "-1m" })],
    ["an unknown key", () => token({}, stranger)],
  ])("refuses %s", async (_, jwt) => {
    expect(await status(request(await jwt()))).toBe(403);
  });
});
