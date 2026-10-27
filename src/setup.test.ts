import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { init } from "./init";
import { answering } from "./prompter";
import { type Call, setEnv, setup } from "./setup";

const ANSWERS = { name: "Rocket", sources: "github", "github.repos": "acme/rocket, acme/ground", "github.useGhToken": false, tz: "Europe/Berlin", cutoff: "18:30", model: "sonnet", publish: "s3", site: "" };
const SECRETS = { SOURCE_TOKEN: "github_pat_SOURCE", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-OAUTH", S3_ACCESS_KEY_ID: "KEYID", S3_SECRET_ACCESS_KEY: "KEYSECRET", SLACK_WEBHOOK_URL: "https://hooks.slack.test/HOOK" };

// A runner that runs nothing: gh knows the user "acme", and no remote or commit exists yet.
function fake(answers: Record<string, (c: Call) => { ok: boolean; out?: string }> = {}) {
  const calls: Call[] = [];
  const run = async (c: Call) => {
    calls.push(c);
    const key = c.cmd.slice(0, 3).join(" ");
    const r = Object.entries(answers).find(([k]) => key.startsWith(k))?.[1](c) ?? (key === "gh api user" ? { ok: true, out: "acme" } : key === "gh repo view" ? { ok: false } : c.read && c.cmd[0] === "git" ? { ok: false } : { ok: true });
    return { ok: r.ok, out: r.out ?? "", err: r.ok ? "" : "no" };
  };
  return { calls, run };
}

async function planned(extra: Record<string, string | boolean> = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), "setup-")), "rocket");
  const { plan } = await init(dir, answering({ ...ANSWERS, ...extra }));
  return plan;
}

const changes = (calls: Call[]) => calls.filter((c) => !c.read).map((c) => c.cmd.join(" "));

test("setup makes a private repo from the data root, then sets its variables and secrets with gh", async () => {
  const plan = await planned();
  const { calls, run } = fake();
  const log: string[] = [];
  const steps = { "repo.create": true, "secrets.set": true, "token.open": false, "claude.auth": "oauth", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.test", ...SECRETS };
  const { repo, done } = await setup(plan, answering(steps), { run, log: (l) => log.push(l) });

  expect(repo).toBe("acme/rocket-digest");
  const d = plan.dir;
  expect(changes(calls)).toEqual([
    `git -C ${d} init`,
    `git -C ${d} add -A`,
    `git -C ${d} commit -m Set up the digest`,
    `gh repo create acme/rocket-digest --private --source ${d} --push`,
    "claude setup-token",
    "gh variable set DIGEST_TZ --body Europe/Berlin --repo acme/rocket-digest",
    "gh variable set CUTOFF --body 18:30 --repo acme/rocket-digest",
    "gh variable set AGENT_MODEL --body sonnet --repo acme/rocket-digest",
    "gh variable set S3_ENDPOINT --body https://acct.r2.cloudflarestorage.test --repo acme/rocket-digest",
    "gh variable set S3_BUCKET --body daily-token --repo acme/rocket-digest",
    "gh secret set SOURCE_TOKEN --repo acme/rocket-digest",
    "gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme/rocket-digest",
    "gh secret set S3_ACCESS_KEY_ID --repo acme/rocket-digest",
    "gh secret set S3_SECRET_ACCESS_KEY --repo acme/rocket-digest",
    "gh secret set SLACK_WEBHOOK_URL --repo acme/rocket-digest",
  ]);
  expect(calls.find((c) => c.cmd[0] === "claude")?.tty).toBe(true);
  // Each secret goes on stdin, and no argv or log line holds one.
  for (const [k, v] of Object.entries(SECRETS)) expect(calls.find((c) => c.cmd.join(" ") === `gh secret set ${k} --repo acme/rocket-digest`)?.input).toBe(v);
  const seen = [...calls.flatMap((c) => c.cmd), ...log].join("\n");
  for (const v of Object.values(SECRETS)) expect(seen).not.toContain(v);
  expect(done).toContain("ANTHROPIC_API_KEY");
  expect(done).not.toContain("SITE_URL");

  // What a local run needs too is in .env; GH_TOKEN is the source token.
  const env = await Bun.file(join(d, ".env")).text();
  expect(env).toContain("S3_ACCESS_KEY_ID=KEYID\n");
  expect(env).toContain("S3_SECRET_ACCESS_KEY=KEYSECRET\n");
  expect(env).toContain("S3_ENDPOINT=https://acct.r2.cloudflarestorage.test\n");
  expect(env).toContain("GH_TOKEN=github_pat_SOURCE\n");
  expect(env).not.toContain("OAUTH");
});

test("an existing remote stays, keys in .env are used, and the API key is the other way in", async () => {
  const plan = await planned();
  await Bun.write(join(plan.dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const env = join(plan.dir, ".env");
  await Bun.write(env, setEnv(setEnv(await Bun.file(env).text(), "S3_ACCESS_KEY_ID", "FROMENV"), "S3_SECRET_ACCESS_KEY", "FROMENVSECRET"));
  const { calls, run } = fake({ "git -C": (c) => (c.cmd.includes("remote") ? { ok: true, out: "git@github.com:acme/kept.git" } : { ok: true }) });
  const { repo } = await setup(plan, answering({ "secrets.set": true, "token.open": true, "claude.auth": "api", ANTHROPIC_API_KEY: "sk-ant-api-KEY" }), { run, log: () => {} });
  expect(repo).toBe("acme/kept");
  expect(changes(calls)).toEqual([
    `${process.platform === "darwin" ? "open" : "xdg-open"} https://github.com/settings/personal-access-tokens/new`,
    "gh variable set DIGEST_TZ --body Europe/Berlin --repo acme/kept",
    "gh variable set CUTOFF --body 18:30 --repo acme/kept",
    "gh variable set AGENT_MODEL --body sonnet --repo acme/kept",
    "gh variable set S3_BUCKET --body daily-token --repo acme/kept",
    "gh secret set ANTHROPIC_API_KEY --repo acme/kept",
    "gh secret set S3_ACCESS_KEY_ID --repo acme/kept",
    "gh secret set S3_SECRET_ACCESS_KEY --repo acme/kept",
  ]);
  expect(calls.find((c) => c.cmd.includes("S3_ACCESS_KEY_ID"))?.input).toBe("FROMENV");
});

test("--dry-run runs only reads and prints each change with its value hidden", async () => {
  const plan = await planned({ site: "https://digest.example.com" });
  const { calls, run } = fake();
  const log: string[] = [];
  const before = await Bun.file(join(plan.dir, ".env")).text();
  const { done } = await setup(plan, answering({ "repo.create": true, "secrets.set": true, "token.open": false, "claude.auth": "oauth", online: true, ...SECRETS }), { run, log: (l) => log.push(l), dry: true });
  expect(calls.every((c) => c.read)).toBe(true);
  expect(await Bun.file(join(plan.dir, ".env")).text()).toBe(before);
  const text = log.join("\n");
  expect(text).toContain("would run gh repo create acme/rocket-digest --private");
  expect(text).toContain("would make https://github.com/acme/rocket-digest");
  expect(done).toEqual([]);
  expect(text).toContain("would run gh secret set SOURCE_TOKEN --repo acme/rocket-digest  (value on stdin, hidden)");
  expect(text).toContain("would run claude setup-token");
  expect(text).toContain("would add to .env: GH_TOKEN, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, SLACK_WEBHOOK_URL");
  expect(text).toMatch(/would run bun \S+cli\.ts github-app\n/);
  expect(text).toMatch(/would run bun \S+cli\.ts deploy$/);
  for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
});

test("a skipped step makes no calls", async () => {
  const plan = await planned({ site: "https://digest.example.com" });
  const { calls, run } = fake();
  const { repo, done } = await setup(plan, answering({ "repo.create": false, "secrets.set": false, online: false }), { run, log: () => {} });
  expect([repo, done, calls]).toEqual([undefined, [], []]);

  // Without a repo the secrets wait unless one is named; an empty answer skips them.
  await setup(plan, answering({ "repo.create": false, "secrets.set": true, repo: "", online: false }), { run, log: () => {} });
  expect(calls).toEqual([]);
});

test("a failed step says what to run to retry, and stops before the push", async () => {
  const plan = await planned();
  const { calls, run } = fake({ "git -C": (c) => ({ ok: !c.cmd.includes("commit") }) });
  const log: string[] = [];
  const { repo } = await setup(plan, answering({ "repo.create": true, "secrets.set": false }), { run, log: (l) => log.push(l) });
  expect(repo).toBeUndefined();
  expect(calls.some((c) => c.cmd[1] === "repo" && c.cmd[2] === "create")).toBe(false);
  const dir = $.escape(plan.dir);
  expect(log.at(-1)).toContain(`To retry: git -C ${dir} commit -m "Set up the digest", then cd ${dir} && gh repo create acme/rocket-digest --private --source . --push`);

  // A repo of that name on GitHub already is left alone.
  const taken = fake({ "gh repo view": () => ({ ok: true }) });
  expect((await setup(plan, answering({ "repo.create": true, "secrets.set": false }), { run: taken.run, log: () => {} })).repo).toBeUndefined();
  expect(changes(taken.calls)).toEqual([]);
});
