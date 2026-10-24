import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { type Asker, door, type Listed, sessionCookie, type SignInEnv } from "./signin";

const env: SignInEnv = { GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret", SESSION_SECRET: "s".repeat(32) };
const projects: Listed[] = [
  { id: "rocket", name: "Rocket", access: { github: ["acme/rocket", "acme/pad"] } },
  { id: "probe", name: "Probe", access: { github: ["acme/probe"], role: "push" } },
  { id: "open", name: "Open", access: "public" },
];
const [rocket, probe, open] = projects;

// GitHub as the tests see it: each code a user, each user's permissions per repo.
const seen: Record<string, Record<string, { pull?: boolean; push?: boolean }>> = {
  crew: { "acme/rocket": { pull: true }, "acme/pad": { pull: true } },
  half: { "acme/pad": { pull: true } },
  reader: { "acme/probe": { pull: true } },
  stranger: {},
};
const ask: Asker = {
  token: async (code) => `token-${code}`,
  login: async (token) => token.replace("token-", ""),
  permissions: async (token, repo) => seen[token.replace("token-", "")]?.[repo] ?? null,
  installations: async (token) => (token === "token-acme" ? [{ account: "acme", url: "https://github.com/settings/installations/1", app: "the-daily-token" }] : []),
};
const gate = door(env, ask);

const cookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]);
const request = (path: string, cookie = "") => new Request(`https://site${path}`, { headers: cookie ? { cookie } : {} });

// Through GitHub and back: the cookie sign-in sets for `who`, or the callback's answer.
async function signIn(who: string, to = "/rocket/2026-01-15/") {
  const start = await gate.auth(request(`/auth/github?to=${encodeURIComponent(to)}`), projects);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  return gate.auth(request(`/auth/callback?code=${who}&state=${state}`, cookies(start)[0]), projects);
}

const session = (project: string, claims: { exp?: string; secret?: string; aud?: string } = {}) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("crew")
    .setIssuer("daily-token")
    .setAudience(claims.aud ?? project)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "1h")
    .sign(new TextEncoder().encode(claims.secret ?? env.SESSION_SECRET));

describe("sign-in", () => {
  test("sends a reader to GitHub with a state it checks on the way back, asking for no scopes", async () => {
    const res = await gate.auth(request("/auth/github?to=/rocket/2026-01-15/"), projects);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe("https://site/auth/callback");
    expect(to.searchParams.has("scope")).toBe(false);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("lets in someone who can see all of the project's repos, for that project only", async () => {
    const res = await signIn("crew");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://site/rocket/2026-01-15/");
    const cookie = cookies(res).find((c) => c.startsWith(`${sessionCookie("rocket")}=`)) ?? "";
    expect(await gate.reads(request("/rocket/", cookie), rocket)).toBe(true);
    expect(await gate.reads(request("/probe/", cookie.replace(sessionCookie("rocket"), sessionCookie("probe"))), probe)).toBe(false);
  });

  test("refuses someone who can't see every repo, or hasn't the role", async () => {
    for (const [who, to] of [["stranger", "/rocket/"], ["half", "/rocket/"], ["reader", "/probe/"]]) {
      const res = await signIn(who, to);
      expect(res.status).toBe(403);
      expect(cookies(res).some((c) => c.startsWith("dt-") && !c.startsWith("dt-state="))).toBe(false);
    }
  });

  test("shows the repos' owner where to give the app the repo, and everyone a way to try again", async () => {
    const owner = await (await signIn("acme")).text();
    expect(owner).toContain('href="https://github.com/settings/installations/1"');
    expect(owner).toContain("/auth/github?to=%2Frocket%2F2026-01-15%2F");
    const stranger = await (await signIn("stranger")).text();
    expect(stranger).not.toContain("github.com/settings/installations");
    expect(stranger).toContain("Sign in again");
  });

  test("refuses a callback whose state isn't the one it gave", async () => {
    const start = await gate.auth(request("/auth/github?to=/rocket/"), projects);
    expect((await gate.auth(request("/auth/callback?code=crew&state=forged", cookies(start)[0]), projects)).status).toBe(400);
    expect((await gate.auth(request("/auth/callback?code=crew&state=forged"), projects)).status).toBe(400);
  });

  test("sends a reader back to / on a host that serves one project", async () => {
    const res = await gate.auth(request("/auth/github?to=%2F"), [rocket]);
    expect(res.status).toBe(302);
    expect((await gate.auth(request("/auth/github?to=%2F"), projects)).status).toBe(400);
  });

  test("sends a reader on only to a digest on this site", async () => {
    for (const to of ["//evil.test/", "https://evil.test/rocket/", "/rocket/../x", "/nope/", "/open/", "/rocket/2026-01-15/data.json"])
      expect((await gate.auth(request(`/auth/github?to=${encodeURIComponent(to)}`), projects)).status).toBe(400);
  });

  test.each([
    ["no cookie", async () => ""],
    ["garbage", async () => "not.a.jwt"],
    ["another project's session", () => session("probe")],
    ["an expired session", () => session("rocket", { exp: "-1m" })],
    ["another secret's session", () => session("rocket", { secret: "t".repeat(32) })],
  ])("doesn't read with %s", async (_, token) => {
    expect(await gate.reads(request("/rocket/", `${sessionCookie("rocket")}=${await token()}`), rocket)).toBe(false);
  });

  test("a public project needs no one", async () => {
    expect(await gate.reads(request("/open/"), open)).toBe(true);
  });

  test("without its settings, no one signs in and a valid session reads nothing", async () => {
    const shut = door({ ...env, SESSION_SECRET: "" }, ask);
    expect((await shut.auth(request("/auth/github?to=/rocket/"), projects)).status).toBe(503);
    expect(await shut.reads(request("/rocket/", `${sessionCookie("rocket")}=${await session("rocket")}`), rocket)).toBe(false);
    expect(await door({ ...env, SESSION_SECRET: "short" }, ask).reads(request("/rocket/", `${sessionCookie("rocket")}=${await session("rocket", { secret: "short" })}`), rocket)).toBe(false);
  });
});
