import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ENGINE } from "./issue";

// deploy: the site on Cloudflare, from the data root's .env. It signs in to Cloudflare if it must, makes the bucket
// if it isn't there, deploys the Worker on its domains and stores the sign-in's secrets. Run it again after a change.
//
//   SITE_URL              the site's address; its host is the Worker's domain unless WORKER_DOMAIN says otherwise
//   WORKER_DOMAIN         optional: the Worker's domains, comma-separated, each in a zone of this Cloudflare account;
//                         a deploy sets the whole list, so with several projects on one Worker it names them all
//   SITE_DOMAIN           optional: gives each project its own host, <id>.<SITE_DOMAIN>
//   S3_BUCKET             the bucket publish writes, bound to the Worker (default daily-token)
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET   the sign-in, from `daily-token github-app`
//   HOME_KEY              optional: the home page (`daily-token home`) shows only at /<HOME_KEY>/, until you're ready

const WRANGLER = "wrangler@4.147.0";
const { values } = parseArgs({
  args: process.argv.slice(2),
  // --root comes from the CLI with every script.
  options: { name: { type: "string", default: process.env.WORKER_NAME ?? "daily-token" }, "dry-run": { type: "boolean", default: false }, root: { type: "string" } },
});
const env = process.env;
const site = env.SITE_URL?.replace(/\/$/, "");
if (!site) throw new Error("set SITE_URL in .env: the site's address, e.g. https://digest.example.com");
const domains = (env.WORKER_DOMAIN || new URL(site).host).split(",").map((d) => d.trim()).filter(Boolean);
const bucket = env.S3_BUCKET || env.R2_BUCKET || "daily-token";
const signIn = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SESSION_SECRET"].filter((k) => !env[k]);

// An empty CLOUDFLARE_API_TOKEN would stand in for the login.
const childEnv = { ...env };
if (!childEnv.CLOUDFLARE_API_TOKEN) delete childEnv.CLOUDFLARE_API_TOKEN;
async function wrangler(args: string[], opts: { quiet?: boolean; input?: string } = {}) {
  const proc = Bun.spawn(["bunx", WRANGLER, ...args], {
    env: childEnv,
    stdin: opts.input === undefined ? "inherit" : new Blob([opts.input]),
    stdout: opts.quiet ? "pipe" : "inherit",
    stderr: opts.quiet ? "pipe" : "inherit",
  });
  const out = opts.quiet ? await new Response(proc.stdout).text() : "";
  return { ok: (await proc.exited) === 0, out };
}
const must = async (args: string[], opts?: { quiet?: boolean; input?: string }) => {
  const r = await wrangler(args, opts);
  if (!r.ok) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed${r.out ? `: ${r.out.trim().split("\n").at(-1)}` : ""}`);
  return r;
};

console.log(`Worker ${values.name} on ${domains.join(", ")}, reading the bucket ${bucket}`);
if (signIn.length) console.log(`No sign-in yet (${signIn.join(", ")} not set): only public projects and previews will show. Run \`daily-token github-app\` first to sign readers in with GitHub.`);
if (values["dry-run"]) process.exit(0);

if (!(await wrangler(["whoami"], { quiet: true })).out.match(/associated with the email|You are logged in/i)) await must(["login"]);

const buckets = (await must(["r2", "bucket", "list"], { quiet: true })).out;
if (!new RegExp(`^name:\\s+${bucket}$`, "m").test(buckets)) {
  console.log(`making the bucket ${bucket}`);
  await must(["r2", "bucket", "create", bucket]);
}

const dir = await mkdtemp(join(tmpdir(), "daily-token-deploy-"));
try {
  const config = join(dir, "wrangler.json");
  await Bun.write(
    config,
    JSON.stringify({
      name: values.name,
      main: join(ENGINE, "deploy", "cloudflare", "src", "index.ts"),
      compatibility_date: "2026-10-01",
      workers_dev: false,
      preview_urls: false,
      r2_buckets: [{ binding: "ISSUES", bucket_name: bucket }],
      // Each deploy sets them all, so an emptied HOME_KEY opens the home page at / again.
      vars: { GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID ?? "", SITE_DOMAIN: env.SITE_DOMAIN ?? "", HOME_KEY: env.HOME_KEY ?? "" },
      observability: { enabled: true },
    }),
  );
  await must(["deploy", "--config", config, ...domains.flatMap((d) => ["--domain", d])]);
  // After the deploy, so the Worker is there; until they land it lets no one in.
  if (env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET)
    await must(["secret", "bulk", "--config", config], { input: JSON.stringify({ GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET, SESSION_SECRET: env.SESSION_SECRET }) });
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(`\nThe site is at ${site}. Publish an issue to it with \`daily-token publish\`.`);
