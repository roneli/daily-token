import { join } from "node:path";
import { $ } from "bun";
import type { Prompter } from "./harness/plugin";
import type { Plan } from "./init";
import { ENGINE, reposOf } from "./issue";

// After init, in a terminal: the data repo on GitHub, its Actions secrets and variables, then the site online.
// Each step can be skipped. Every command goes through a Runner, so tests see the calls; --dry-run prints them.
// A secret goes to gh on stdin, never in argv, and no log shows it.

export type Call = { cmd: string[]; cwd?: string; input?: string; tty?: boolean; read?: boolean };
export type Runner = (c: Call) => Promise<{ ok: boolean; out: string; err: string }>;
type Options = { run: Runner; log: (line: string) => void; dry?: boolean };

export const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
export const R2_TOKENS = "https://developers.cloudflare.com/r2/api/tokens/";
const REPO = /^[\w.-]+\/[\w.-]+$/;

export const spawn: Runner = async (c) => {
  try {
    const proc = Bun.spawn(c.cmd, {
      cwd: c.cwd,
      stdin: c.input !== undefined ? new Blob([c.input]) : c.tty ? "inherit" : "ignore",
      stdout: c.tty ? "inherit" : "pipe",
      stderr: c.tty ? "inherit" : "pipe",
    });
    const [out, err] = c.tty ? ["", ""] : await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    return { ok: (await proc.exited) === 0, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
};

export const shown = (c: Call) => `${c.cmd.map((a) => $.escape(a)).join(" ")}${c.input !== undefined ? "  (value on stdin, hidden)" : ""}`;

// .env lines: a key's line is replaced, or added at the end.
export function setEnv(text: string, key: string, value: string, keep = false) {
  const line = new RegExp(`^${key}=(.*)$`, "m");
  const had = line.exec(text);
  if (had && keep && had[1]) return text;
  return had ? text.replace(line, () => `${key}=${value}`) : `${text}${text.endsWith("\n") || !text ? "" : "\n"}${key}=${value}\n`;
}
const readEnv = (text: string) => Object.fromEntries([...text.matchAll(/^([A-Za-z_][\w]*)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const lastLine = (s: string) => s.split("\n").at(-1) ?? "";

export async function setup(plan: Plan, p: Prompter, o: Options) {
  const exec = async (c: Call) => {
    if (c.read) return o.run(c);
    o.log(`${o.dry ? "would run" : "$"} ${shown(c)}`);
    return o.dry ? { ok: true, out: "", err: "" } : o.run(c);
  };
  const repo = await createRepo(plan, p, exec, o.log, o.dry);
  const done = await setSecrets(plan, p, exec, o, repo);
  await goOnline(plan, p, exec, o.log);
  // A dry run set nothing, so the next steps still list it all.
  return { repo, done: o.dry ? [] : done };
}

type Exec = (c: Call) => Promise<{ ok: boolean; out: string; err: string }>;

// (a) A private repo on GitHub, pushed from the data root. A remote that's there already stays.
export async function createRepo(plan: Plan, p: Prompter, exec: Exec, log: (line: string) => void, dry = false): Promise<string | undefined> {
  const { dir } = plan;
  const git = (...args: string[]): Call => ({ cmd: ["git", "-C", dir, ...args] });
  // A data root inside another repo isn't a repo of its own: only its own .git counts.
  const isRepo = await Bun.file(join(dir, ".git", "HEAD")).exists();
  if (isRepo) {
    const remote = await exec({ ...git("remote", "get-url", "origin"), read: true });
    if (remote.ok && remote.out) {
      log(`The data root already has a remote, origin = ${remote.out}. It stays.`);
      return remote.out.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
    }
  }
  if (!(await p.confirm({ id: "repo.create", message: "Create the data repo on GitHub now? A private repo, pushed from this folder", initial: true }))) return undefined;
  const user = await exec({ cmd: ["gh", "api", "user", "--jq", ".login"], read: true });
  if (!user.ok) {
    log("gh isn't signed in. Run `gh auth login`, then `daily-token init` again to make the repo.");
    return undefined;
  }
  const name = await p.text({ id: "repo", message: "The data repo, owner/name", initial: `${user.out}/${plan.project.id}-digest`, validate: (v) => (REPO.test(v) ? undefined : "owner/name") });
  const retry = `cd ${$.escape(dir)} && gh repo create ${name} --private --source . --push`;
  if ((await exec({ cmd: ["gh", "repo", "view", name, "--json", "name"], read: true })).ok) {
    log(`${name} is on GitHub already; it isn't touched. Pick another name with \`daily-token init\`, or add it yourself: git remote add origin https://github.com/${name}.git`);
    return undefined;
  }
  const ignore = Bun.file(join(dir, ".gitignore"));
  if (!(await ignore.exists()) || !/^\/?\.env$/m.test(await ignore.text())) {
    log(".gitignore doesn't name .env, so the first commit could hold its keys. Add `.env` to it, then run: git init && git add -A && git commit -m 'Set up the digest' && gh repo create ...");
    return undefined;
  }
  const steps: Call[] = [];
  if (!isRepo) steps.push(git("init"));
  if (!isRepo || !(await exec({ ...git("rev-parse", "--verify", "-q", "HEAD"), read: true })).ok) steps.push(git("add", "-A"), git("commit", "-m", "Set up the digest"));
  steps.push({ cmd: ["gh", "repo", "create", name, "--private", "--source", dir, "--push"] });
  for (const step of steps) {
    const r = await exec(step);
    if (!r.ok) {
      log(`That stopped${r.err ? `: ${lastLine(r.err)}` : ""}. To retry: ${step.cmd[0] === "gh" ? retry : `${shown(step)}, then ${retry}`}`);
      return undefined;
    }
  }
  log(`${dry ? "would make" : "Made"} https://github.com/${name}, private.`);
  return name;
}

// (b) The repo's Actions secrets and variables. Each secret's page or command comes first, then its value, hidden.
export async function setSecrets(plan: Plan, p: Prompter, exec: Exec, o: Options, known?: string): Promise<string[]> {
  if (!(await p.confirm({ id: "secrets.set", message: "Set the data repo's Actions secrets and variables now, with gh? Each value is read hidden", initial: true }))) return [];
  const repo = known ?? (await p.text({ id: "repo", message: "Which GitHub repo do the workflows run in? owner/name (empty to skip)", initial: "", validate: (v) => (!v || REPO.test(v) ? undefined : "owner/name") }));
  if (!repo) return [];
  const envPath = join(plan.dir, ".env");
  const envText = (await Bun.file(envPath).exists()) ? await Bun.file(envPath).text() : "";
  const env = readEnv(envText);
  const vars: Record<string, string> = Object.fromEntries(Object.entries(plan.vars).map(([k, v]) => [k, env[k] || v]));
  const secrets: Record<string, string> = {};
  // What a local run needs too goes in .env; a value there already stays.
  const local: Record<string, string> = {};
  const keep = (key: string, value: string) => {
    if (value && !env[key]) local[key] = value;
  };

  for (const { name, why } of plan.secrets) {
    if (name === "SOURCE_TOKEN") {
      const repos = reposOf(plan.project);
      p.note(
        [
          `A fine-grained personal access token lets the daily workflow read ${repos.join(", ") || "the repos"}.`,
          "On GitHub's page: the repos' owner as Resource owner, Only select repositories with those repos,",
          "and under Repository permissions: Contents, Pull requests and Issues, each Read-only.",
          TOKEN_URL,
        ].join("\n"),
        "SOURCE_TOKEN",
      );
      if (await p.confirm({ id: "token.open", message: "Open that page in your browser?", initial: true })) {
        const r = await exec({ cmd: [process.platform === "darwin" ? "open" : "xdg-open", TOKEN_URL] });
        if (!r.ok) o.log(`Open it yourself: ${TOKEN_URL}`);
      }
      const v = await p.secret({ id: "SOURCE_TOKEN", message: "Paste the token (empty to skip)" });
      if (v) secrets.SOURCE_TOKEN = v;
      keep("GH_TOKEN", v);
    } else if (name === "ANTHROPIC_API_KEY") {
      const how = await p.select({
        id: "claude.auth",
        message: "How do the agents sign in on GitHub Actions?",
        options: [
          { value: "oauth", label: "With your Claude subscription", hint: "runs claude setup-token" },
          { value: "api", label: "With an Anthropic API key", hint: "billed per use" },
          { value: "skip", label: "Later" },
        ],
        initial: "oauth",
      });
      if (how === "oauth") {
        const r = await exec({ cmd: ["claude", "setup-token"], tty: true });
        if (!r.ok) o.log("claude setup-token stopped. Run it yourself, then paste its token here or later.");
        const v = await p.secret({ id: "CLAUDE_CODE_OAUTH_TOKEN", message: "Paste the token claude setup-token printed (empty to skip)" });
        if (v) secrets.CLAUDE_CODE_OAUTH_TOKEN = v;
      } else if (how === "api") {
        p.note("Create a key at https://console.anthropic.com/settings/keys", "ANTHROPIC_API_KEY");
        const v = await p.secret({ id: "ANTHROPIC_API_KEY", message: "Paste the key (empty to skip)" });
        if (v) secrets.ANTHROPIC_API_KEY = v;
      }
    } else if (name === "S3_ACCESS_KEY_ID" || name === "S3_SECRET_ACCESS_KEY") {
      if (name === "S3_SECRET_ACCESS_KEY") continue;
      if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
        o.log("The bucket's keys come from .env.");
        secrets.S3_ACCESS_KEY_ID = env.S3_ACCESS_KEY_ID;
        secrets.S3_SECRET_ACCESS_KEY = env.S3_SECRET_ACCESS_KEY;
        continue;
      }
      p.note(
        [
          "On Cloudflare R2: the dashboard → R2 → Manage API tokens → Create API token,",
          `with Object Read & Write, applied to the bucket ${vars.S3_BUCKET || "daily-token"}. It shows the key, its secret and the S3 endpoint.`,
          "Another S3 store: a key that may read and write that bucket.",
          R2_TOKENS,
        ].join("\n"),
        "The bucket's keys",
      );
      for (const key of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
        const v = env[key] || (await p.secret({ id: key, message: `${key === "S3_ACCESS_KEY_ID" ? "Access Key ID" : "Secret Access Key"} (empty to skip)` }));
        if (v) secrets[key] = v;
        keep(key, v);
      }
    } else if (name === "SLACK_WEBHOOK_URL") {
      const v = env.SLACK_WEBHOOK_URL || (await p.secret({ id: name, message: "Optional: a Slack incoming webhook URL, from api.slack.com/apps → your app → Incoming Webhooks (empty to skip)" }));
      if (v) secrets[name] = v;
      keep(name, v);
    } else {
      const v = await p.secret({ id: name, message: `${name}: ${why} (empty to skip)` });
      if (v) secrets[name] = v;
    }
  }
  if ("S3_ENDPOINT" in vars && !vars.S3_ENDPOINT) {
    vars.S3_ENDPOINT = await p.text({
      id: "S3_ENDPOINT",
      message: "The bucket's S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com (empty to skip)",
      initial: "",
      validate: (v) => (!v || /^https:\/\/\S+$/.test(v) ? undefined : "an https:// address, or nothing"),
    });
    keep("S3_ENDPOINT", vars.S3_ENDPOINT);
  }

  const keys = Object.keys(local);
  if (keys.length && o.dry) o.log(`would add to .env: ${keys.join(", ")}`);
  else if (keys.length) {
    await Bun.write(envPath, keys.reduce((text, k) => setEnv(text, k, local[k]), envText));
    o.log(`Added to .env: ${keys.join(", ")}`);
  }

  const done: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!v) continue;
    const r = await exec({ cmd: ["gh", "variable", "set", k, "--body", v, "--repo", repo] });
    if (r.ok) done.push(k);
    else o.log(`variable ${k} wasn't set${r.err ? `: ${lastLine(r.err)}` : ""}. To retry: gh variable set ${k} --body ${$.escape(v)} --repo ${repo}`);
  }
  for (const [k, v] of Object.entries(secrets)) {
    const r = await exec({ cmd: ["gh", "secret", "set", k, "--repo", repo], input: v });
    if (r.ok) done.push(k);
    else o.log(`secret ${k} wasn't set${r.err ? `: ${lastLine(r.err)}` : ""}. To retry: gh secret set ${k} --repo ${repo}, and paste it`);
  }
  // The OAuth token stands in for the API key.
  if (done.includes("CLAUDE_CODE_OAUTH_TOKEN")) done.push("ANTHROPIC_API_KEY");
  return done;
}

// (c) The site online: the GitHub App for the sign-in, then the Worker. Each reads the data root's .env.
async function goOnline(plan: Plan, p: Prompter, exec: Exec, log: (line: string) => void) {
  const site = plan.vars.SITE_URL;
  if (!site || !(await p.confirm({ id: "online", message: `Put the site online at ${site} now? This makes a GitHub App for the sign-in, then deploys to Cloudflare`, initial: true }))) return;
  for (const command of ["github-app", "deploy"]) {
    const r = await exec({ cmd: ["bun", join(ENGINE, "src", "cli.ts"), command], cwd: plan.dir, tty: true });
    if (!r.ok) {
      log(`${command} stopped; run \`daily-token ${command}\` in the data root to try again`);
      break;
    }
  }
}
