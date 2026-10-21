import { join } from "node:path";
import { errorsOf, load } from "./harness/schema";
import { type Project, readJson } from "./issue";
import { configured } from "./sources";

// doctor: whether a data root is ready for a daily run. Each check says what's wrong and how to fix it.

export type Finding = { ok: boolean; what: string; detail?: string };

export async function doctor(root: string, env = process.env): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (what: string, problems: string[]) => out.push({ what, ok: !problems.length, detail: problems.join("; ") || undefined });

  const projectFile = Bun.file(join(root, "project.json"));
  if (!(await projectFile.exists())) return [{ ok: false, what: "project.json", detail: `no project.json in ${root}; run \`bun create daily-token\` or pass --root` }];
  const project = await readJson<Project>(join(root, "project.json"));
  add("project.json", errorsOf(await load("project"), project, "project"));

  const systemFile = Bun.file(join(root, "system.json"));
  add("system.json", (await systemFile.exists()) ? errorsOf(await load("system"), await systemFile.json(), "system") : ["missing; draw one with `daily-token project cartographer`"]);

  // The brief is optional; one that is there must be valid, or every run stops on it.
  const briefFile = Bun.file(join(root, "brief.json"));
  if (await briefFile.exists()) add("brief.json", errorsOf(await load("brief"), await briefFile.json(), "brief"));
  else out.push({ ok: true, what: "brief.json", detail: "none yet; `daily-token project brief` drafts one from the repos' docs" });

  let sources: ReturnType<typeof configured> = [];
  try {
    sources = configured(project);
  } catch (e) {
    add("sources", [(e as Error).message]);
  }
  for (const { source, config } of sources) add(`source ${source.name}`, await source.doctor(config));

  const claude = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
  add("claude CLI", claude.success ? [] : ["not found; install @anthropic-ai/claude-code, then log in (locally) or set ANTHROPIC_API_KEY (CI)"]);

  // Publishing is optional; half of it set is a mistake.
  const r2 = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const set = r2.filter((k) => env[k]);
  if (set.length) add("publishing (R2)", set.length === r2.length ? [] : [`missing ${r2.filter((k) => !env[k]).join(", ")}`]);
  return out;
}
