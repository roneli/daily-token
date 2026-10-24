import { GitHub, generateState } from "arctic";
import { jwtVerify, SignJWT } from "jose";

// Sign-in with GitHub. A reader gets into a project when their GitHub account can see every one of its repos with at
// least its role: a digest tells of all of them. GitHub is asked once, at sign-in, with a GitHub App's user token,
// which reaches only the repos the app is installed on and reads only their Metadata. The answer is kept in a signed
// cookie per project, for SESSION_HOURS.

export type Role = "pull" | "triage" | "push" | "maintain" | "admin";
// "public": no sign-in. Else the repos a reader must see, all of them; publish fills it from the project's GitHub source.
export type Access = "public" | { github: string[]; role?: Role };
export type Listed = { id: string; name: string; access?: Access };

export type SignInEnv = { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; SESSION_SECRET?: string };

// What sign-in asks GitHub; tests stand in for it.
export type Asker = {
  token(code: string, redirect: string): Promise<string>;
  login(token: string): Promise<string>;
  // The user's permissions on the repo, or null when they can't see it.
  permissions(token: string, repo: string): Promise<Partial<Record<Role, boolean>> | null>;
  // The app's installations the user can see: on whose account, and the page that sets its repos.
  installations(token: string): Promise<{ account: string; url: string; app: string }[]>;
};

// What the site asks: may this request read the project, and the /auth/ routes.
export type Door = {
  reads(req: Request, project: Listed): Promise<boolean>;
  auth(req: Request, projects: Listed[]): Promise<Response>;
};

export const SESSION_HOURS = 12;
const STATE = "dt-state";
const ISSUER = "daily-token";
// Where sign-in may send a reader on to: a project, an issue or the archive, so it can't be sent off the site; or /,
// on a host that serves one project.
const TO = /^\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2}\/|archive)?$/;

export const sessionCookie = (project: string) => `dt-${project}`;
export const signInPath = (to: string) => `/auth/github?to=${encodeURIComponent(to)}`;

function cookieOf(req: Request, name: string): string | undefined {
  for (const c of req.headers.get("cookie")?.split(/;\s*/) ?? []) if (c.startsWith(`${name}=`)) return c.slice(name.length + 1);
}

function setCookie(req: Request, name: string, value: string, seconds: number, path = "/") {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${path}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure}`;
}

type Link = { href: string; label: string };

// A page that says what went wrong, with a button or two to go on.
const page = (status: number, title: string, text: string, links: Link[] = [], headers: HeadersInit = {}) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:40px 16px}nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}a{padding:10px 16px;border-radius:8px;border:1px solid #8886;color:inherit;text-decoration:none;font-weight:600}a:first-child{background:#1f2328;border-color:#1f2328;color:#fff}</style><h1>${title}</h1><p>${text}</p>${links.length ? `<nav>${links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join("")}</nav>` : ""}`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } },
  );

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function github(env: SignInEnv): Asker {
  const api = async (token: string, path: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "daily-token", "x-github-api-version": "2022-11-28" },
    });
  return {
    async token(code, redirect) {
      return (await new GitHub(env.GITHUB_CLIENT_ID ?? "", env.GITHUB_CLIENT_SECRET ?? "", redirect).validateAuthorizationCode(code)).accessToken();
    },
    async login(token) {
      const res = await api(token, "/user");
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for the user`);
      return ((await res.json()) as { login: string }).login;
    },
    async permissions(token, repo) {
      const res = await api(token, `/repos/${repo}`);
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
      return ((await res.json()) as { permissions?: Partial<Record<Role, boolean>> }).permissions ?? null;
    },
    async installations(token) {
      const res = await api(token, "/user/installations");
      if (!res.ok) return [];
      const body = (await res.json()) as { installations: { account: { login: string }; html_url: string; app_slug: string }[] };
      return body.installations.map((i) => ({ account: i.account.login, url: i.html_url, app: i.app_slug }));
    },
  };
}

// The door for the site. Without all three settings no one signs in, so a project that isn't public stays shut.
export function door(env: SignInEnv, ask: Asker = github(env)): Door {
  const ready = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);
  const key = new TextEncoder().encode(env.SESSION_SECRET ?? "");

  async function reads(req: Request, project: Listed) {
    if (project.access === "public") return true;
    const token = cookieOf(req, sessionCookie(project.id));
    if (!ready || !token) return false;
    try {
      await jwtVerify(token, key, { issuer: ISSUER, audience: project.id, algorithms: ["HS256"] });
      return true;
    } catch {
      return false;
    }
  }

  async function auth(req: Request, projects: Listed[]) {
    const url = new URL(req.url);
    if (!ready) return page(503, "Sign-in isn't set up", "This site needs GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET.");
    const redirect = `${url.origin}/auth/callback`;
    const projectOf = (to: string) => {
      const m = TO.exec(to);
      const project = to === "/" && projects.length === 1 ? projects[0] : m && projects.find((p) => p.id === m[1]);
      return project && project.access !== "public" ? project : undefined;
    };

    if (url.pathname === "/auth/github") {
      const to = url.searchParams.get("to") ?? "";
      if (!projectOf(to)) return page(400, "Nothing to sign in to", "This link doesn't lead to a digest.", [{ href: "/", label: "Go to the site" }]);
      const state = generateState();
      const location = new GitHub(env.GITHUB_CLIENT_ID ?? "", "", redirect).createAuthorizationURL(state, []).toString();
      return new Response(null, { status: 302, headers: { location, "set-cookie": setCookie(req, STATE, `${state}~${to}`, 600, "/auth/"), "cache-control": "no-store" } });
    }

    if (url.pathname === "/auth/callback") {
      const [state, to = ""] = cookieOf(req, STATE)?.split("~") ?? [];
      const code = url.searchParams.get("code");
      const project = projectOf(to);
      // The way back in: where the reader was going, when the state cookie still says.
      const again: Link = { href: project ? signInPath(to) : "/", label: "Sign in again" };
      if (!state || state !== url.searchParams.get("state") || !code || !project) return page(400, "Sign-in expired", "It took too long, or started in another tab.", [again]);
      const done = setCookie(req, STATE, "", 0, "/auth/");
      let login: string;
      let allowed = false;
      let missing: string | undefined;
      let fix: Link | undefined;
      try {
        const token = await ask.token(code, redirect);
        login = await ask.login(token);
        const access = project.access as Exclude<Access, "public"> | undefined;
        const role = access?.role ?? "pull";
        allowed = Boolean(access?.github.length);
        for (const repo of access?.github ?? []) {
          const permissions = await ask.permissions(token, repo);
          if (permissions?.[role]) continue;
          console.log(`sign-in: ${login} on ${repo}: ${permissions ? JSON.stringify(permissions) : "can't see it"}`);
          allowed = false;
          missing = repo;
          break;
        }
        // The repo's owner can give the app the repo there and then: the installation's page, or a new one.
        const owner = missing?.split("/")[0];
        if (owner && owner.toLowerCase() === login.toLowerCase()) {
          const installs = await ask.installations(token);
          const mine = installs.find((i) => i.account.toLowerCase() === owner.toLowerCase());
          if (mine) fix = { href: mine.url, label: `Give the app ${missing}` };
          else if (installs[0]) fix = { href: `https://github.com/apps/${installs[0].app}/installations/new`, label: `Install the app on ${owner}` };
        }
      } catch (e) {
        console.error(`sign-in: ${e instanceof Error ? e.message : e}`);
        return page(502, "GitHub didn't answer", "Try again in a moment.", [again], { "set-cookie": done });
      }
      if (!allowed) {
        const text = fix
          ? `You own ${escapeHtml(missing ?? "")}, but the sign-in's GitHub App isn't installed on it, so GitHub won't show it to the sign-in. Give the app the repo, then sign in again.`
          : `GitHub didn't show your account ${escapeHtml(login)} all of this digest's repos. Either the account can't see them, or the sign-in's GitHub App isn't installed on them yet: the repos' owner installs it. Ask the digest's owner, or sign in to GitHub with another account.`;
        return page(403, "No access", text, fix ? [fix, again] : [again], { "set-cookie": done });
      }
      const session = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(login).setIssuer(ISSUER).setAudience(project.id).setIssuedAt().setExpirationTime(`${SESSION_HOURS}h`).sign(key);
      const headers = new Headers({ location: new URL(to, url.origin).toString(), "cache-control": "no-store" });
      headers.append("set-cookie", done);
      headers.append("set-cookie", setCookie(req, sessionCookie(project.id), session, SESSION_HOURS * 3600));
      return new Response(null, { status: 302, headers });
    }

    return new Response("Not found", { status: 404 });
  }

  return { reads, auth };
}
