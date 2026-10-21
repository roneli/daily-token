import type { Source } from "../../harness/plugin";
import type { GithubDay } from "../../issue";
import { collect, rest } from "./collect";

export type GithubConfig = { repos: string[] };

export const github: Source<GithubConfig, GithubDay> = {
  name: "github",
  config: {
    type: "object",
    additionalProperties: false,
    required: ["repos"],
    properties: { repos: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^[\\w.-]+/[\\w.-]+$" }, description: "The first repo is home: its PRs are cited as 123, other repos' as \"name#123\"." } },
  },
  collect: (ctx, config) => collect({ root: ctx.root, date: ctx.date, cutoff: ctx.cutoff, tz: ctx.tz, project: ctx.project, system: ctx.system, repos: config.repos }),
  async setup(p, current) {
    p.note("The first repo is home: its PRs are cited as #123, the others' as name#123.", "GitHub");
    const repos = (
      await p.text({
        id: "github.repos",
        message: "Which repos? owner/name, comma-separated, home first",
        initial: current?.repos.join(", "),
        placeholder: "acme/rocket, acme/ground",
        validate: (v) => (v.split(",").map((r) => r.trim()).every((r) => /^[\w.-]+\/[\w.-]+$/.test(r)) ? undefined : "each repo is owner/name"),
      })
    ).split(",").map((r) => r.trim());
    const gh = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const found = gh.success ? gh.stdout.toString().trim() : "";
    const env: Record<string, string> = {};
    if (process.env.GH_TOKEN) p.note("GH_TOKEN is already set in your environment.", "Token");
    else if (found && (await p.confirm({ id: "github.useGhToken", message: "Use your gh login's token locally? It goes in .env, which git ignores", initial: true }))) env.GH_TOKEN = found;
    return { config: { repos }, env, secrets: [{ name: "SOURCE_TOKEN", why: "a fine-grained read-only token for the repos: contents, pull requests, issues" }] };
  },
  async doctor(config) {
    if (!process.env.GH_TOKEN) return ["GH_TOKEN is not set: a read-only token for the repos (contents, pull requests, issues)"];
    const problems: string[] = [];
    for (const repo of config.repos) await rest(`repos/${repo}`).catch((e: Error) => problems.push(`${repo}: ${e.message.split(":")[0]}`));
    return problems;
  },
  empty: (day) => !day.prs.length && !day.commits?.length,
  summary: (day) => `${day.prs.length} PRs, ${day.commits?.length ?? 0} commits, ${day.issues?.length ?? 0} issues, ${day.openPrs.length} open PRs, ${day.tags.length} tags`,
};
