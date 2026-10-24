import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

// Makes the GitHub App readers sign in with, from a manifest: GitHub shows the app filled in, you press Create, and
// its Client ID and secret land in .env with a new SESSION_SECRET. The app asks for no permissions and has no webhook.
const { values } = parseArgs({
  args: process.argv.slice(2),
  // --root comes from the CLI with every script; the app is the site's, not a project's.
  options: { site: { type: "string", default: process.env.SITE_URL }, org: { type: "string" }, env: { type: "string", default: ".env" }, root: { type: "string" } },
});
const site = values.site?.replace(/\/$/, "");
if (!site) throw new Error("--site https://digest.example.com, or SITE_URL in .env: the site readers sign in to");
const host = new URL(site).host;

const state = randomBytes(16).toString("hex");
let done: (app: { slug: string; client_id: string; client_secret: string; html_url: string }) => void;
const made = new Promise<Parameters<typeof done>[0]>((resolve) => (done = resolve));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      const manifest = {
        name: "The Daily Token",
        url: site,
        description: `Sign in to read ${host}. It reads nothing: GitHub tells it only whether you can see the digest's repos.`,
        callback_urls: [`${site}/auth/callback`, "http://localhost:8787/auth/callback"],
        redirect_url: `${url.origin}/made`,
        hook_attributes: { url: site, active: false },
        public: false,
        default_permissions: {},
      };
      const to = values.org ? `https://github.com/organizations/${values.org}/settings/apps/new` : "https://github.com/settings/apps/new";
      const json = JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      return new Response(
        `<!doctype html><meta charset="utf-8"><form method="post" action="${to}?state=${state}"><input type="hidden" name="manifest" value="${json}"><button>Create the GitHub App</button></form><script>document.forms[0].submit()</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url.pathname === "/made" && url.searchParams.get("state") === state) {
      const res = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "daily-token" } });
      if (!res.ok) return new Response(`GitHub answered ${res.status}: ${await res.text()}`, { status: 502 });
      const app = (await res.json()) as Parameters<typeof done>[0];
      done(app);
      return Response.redirect(`https://github.com/apps/${app.slug}/installations/new`);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Open ${server.url} to create the app on GitHub${values.org ? ` for ${values.org}` : ""}.`);
Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", server.url.toString()], { stdio: ["ignore", "ignore", "ignore"] });
const app = await made;
server.stop();

// Each value replaces its line in .env, or is added; a SESSION_SECRET already set stays, so no one is signed out.
const file = Bun.file(values.env);
let text = (await file.exists()) ? await file.text() : "";
const set = (key: string, value: string, keep = false) => {
  const line = new RegExp(`^${key}=(.*)$`, "m");
  const had = line.exec(text);
  if (had && keep && had[1]) return;
  text = had ? text.replace(line, `${key}=${value}`) : `${text}${text.endsWith("\n") || !text ? "" : "\n"}${key}=${value}\n`;
};
set("GITHUB_CLIENT_ID", app.client_id);
set("GITHUB_CLIENT_SECRET", app.client_secret);
set("SESSION_SECRET", randomBytes(32).toString("hex"), true);
await Bun.write(values.env, text);
console.log(`Made ${app.html_url}; its Client ID and secret are in ${values.env}.
Now install it on the project's repos, in the page GitHub opened: https://github.com/apps/${app.slug}/installations/new`);
