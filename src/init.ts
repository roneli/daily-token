import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Prompter } from "./harness/plugin";
import { ENGINE, engineVersion, type Project, readJson, reposOf, writeJson } from "./issue";
import { migrate } from "./migrate";
import { configured, SOURCES } from "./sources";
import { zoned } from "./time";

// init: a data root set up, or an existing one brought up to date. A data root is its own repo: the project's
// config, its issues, and the workflows that make one a day. The engine is a pinned dependency of it.
// Files that are there already are kept; only project.json is rewritten, from the answers.

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type Day = (typeof DAYS)[number];

// Before the Cartographer draws the map, the whole project is one part.
const STARTER_SYSTEM = {
  size: [560, 200],
  groups: [],
  parts: [{ id: "all", name: "Everything", sub: "until the map is drawn", what: "The whole project, before the Cartographer splits it into parts.", box: [20, 20, 520, 160], paths: ["**"] }],
  edges: [],
};

export type Plan = { dir: string; project: Project; env: Record<string, string>; secrets: { name: string; why: string }[]; vars: Record<string, string>; publish: "none" | "s3" };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "digest";

export async function ask(dir: string, p: Prompter): Promise<Plan> {
  const file = Bun.file(join(dir, "project.json"));
  const existing = (await file.exists()) ? await readJson<Project>(join(dir, "project.json")) : undefined;
  if (existing) {
    const changes = await migrate(dir, { dryRun: true });
    if (changes.length && (await p.confirm({ id: "migrate", message: `This data root is an older format: convert ${changes.length} files? The words don't change`, initial: true }))) await migrate(dir);
  }
  const current = existing ? await readJson<Project>(join(dir, "project.json")) : undefined;

  const name = await p.text({ id: "name", message: "What's the project called?", initial: current?.name ?? basename(resolve(dir)), validate: (v) => (v.trim() && v.length <= 32 ? undefined : "1 to 32 characters") });
  const id = await p.text({
    id: "id",
    message: "Its id, for the site path /<id>/<date>/",
    initial: current?.id ?? slug(name),
    validate: (v) => (!/^[a-z0-9-]+$/.test(v) ? "lowercase letters, digits and dashes" : ["static", "archive", "share"].includes(v) ? "that path is taken" : undefined),
  });

  const had = current ? Object.fromEntries(configured(current).map((c) => [c.source.name, c.config])) : {};
  const names = await p.multiselect({ id: "sources", message: "Where does the work come from?", options: SOURCES.map((s) => ({ value: s.name, label: s.name })), initial: current ? Object.keys(had) : ["github"] });
  const sources: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const secrets: Plan["secrets"] = [];
  for (const n of names) {
    const source = SOURCES.find((s) => s.name === n);
    if (!source) continue;
    const r = await source.setup(p, had[n]);
    sources[n] = r.config;
    Object.assign(env, r.env);
    secrets.push(...r.secrets);
  }

  const tz = await p.text({ id: "tz", message: "Which time zone does the day end in?", initial: process.env.DIGEST_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone, validate: (v) => (validZone(v) ? undefined : "an IANA zone, like Europe/Berlin") });
  const cutoff = await p.text({ id: "cutoff", message: "When does the day end? An issue covers everything since the last cutoff", initial: process.env.CUTOFF ?? "18:00", validate: (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? undefined : "HH:MM, 24-hour") });
  const days = await p.multiselect<Day>({ id: "days", message: "Which days does an issue come out?", options: DAYS.map((d) => ({ value: d, label: d })), initial: current?.days ?? ["mon", "tue", "wed", "thu", "fri"] });
  const weekly = await p.select({ id: "weekly", message: "Which day also looks back at the week?", options: [{ value: "none", label: "none" }, ...DAYS.map((d) => ({ value: d, label: d }))], initial: current?.weekly ?? "none" });
  const model = await p.select({ id: "model", message: "Which model do the agents use?", options: [{ value: "opus", label: "opus", hint: "best writing and judgment" }, { value: "sonnet", label: "sonnet", hint: "cheaper" }], initial: "opus" });
  const publish = await p.select({ id: "publish", message: "Where do issues go?", options: [{ value: "none", label: "Nowhere yet", hint: "render and preview locally" }, { value: "s3", label: "An S3-compatible bucket", hint: "AWS S3, Cloudflare R2, MinIO; with an optional Slack post" }], initial: "none" });

  const vars: Record<string, string> = { DIGEST_TZ: tz, CUTOFF: cutoff, AGENT_MODEL: model };
  secrets.push({ name: "ANTHROPIC_API_KEY", why: "or CLAUDE_CODE_OAUTH_TOKEN: the agents run through the claude CLI" });
  if (publish === "s3") {
    secrets.push({ name: "S3_ACCESS_KEY_ID", why: "a write key for the bucket" }, { name: "S3_SECRET_ACCESS_KEY", why: "and its secret" }, { name: "SLACK_WEBHOOK_URL", why: "optional: posts each issue to a channel" });
    Object.assign(vars, { S3_ENDPOINT: "", S3_BUCKET: "daily-token", SITE_URL: "" });
  }
  const all = days.length === DAYS.length;
  const project: Project = { ...current, id, name, sources, ...(all ? {} : { days }), ...(weekly === "none" ? {} : { weekly: weekly as Day }) };
  if (all) delete project.days;
  if (weekly === "none") delete project.weekly;
  delete project.repos;
  return { dir, project, env: { ...env, DIGEST_TZ: tz, CUTOFF: cutoff, AGENT_MODEL: model }, secrets, vars, publish };
}

function validZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Writes the data root. Returns the files it wrote; a file that's there already is left alone.
export async function scaffold(plan: Plan): Promise<string[]> {
  const { dir } = plan;
  const written: string[] = [];
  const put = async (file: string, body: string) => {
    const path = join(dir, file);
    if (await Bun.file(path).exists()) return;
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, body);
    written.push(file);
  };
  await mkdir(join(dir, "issues"), { recursive: true });
  await writeJson(join(dir, "project.json"), plan.project);
  written.push("project.json");
  await put("system.json", `${JSON.stringify(STARTER_SYSTEM, null, 1)}\n`);
  const version = await engineVersion();
  await put("package.json", `${JSON.stringify({ name: `${plan.project.id}-digest`, private: true, type: "module", scripts: { issue: "daily-token run", preview: "daily-token preview", doctor: "daily-token doctor", map: "daily-token project cartographer", brief: "daily-token project brief" }, dependencies: { "daily-token": version } }, null, 2)}\n`);
  // /trace/ is the project collectors' traces; an issue's own trace/ is kept with the issue.
  await put(".gitignore", "node_modules/\nout/\n.env\n/trace/\n");
  const envLines = (values: Record<string, string>) => Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n");
  await put(".env.example", `# Copy to .env. CI sets the same names as secrets and variables.\n${envLines({ ...Object.fromEntries(plan.secrets.map((s) => [s.name === "SOURCE_TOKEN" ? "GH_TOKEN" : s.name, ""])), ...plan.vars })}\n`);
  // .env gets what the answers gave and keeps whatever it had.
  const envFile = Bun.file(join(dir, ".env"));
  const before = (await envFile.exists()) ? await envFile.text() : "";
  const missing = Object.entries(plan.env).filter(([k]) => !new RegExp(`^${k}=`, "m").test(before));
  if (missing.length) {
    await Bun.write(envFile, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${envLines(Object.fromEntries(missing))}\n`);
    written.push(".env");
  }
  const starter = (f: string) => Bun.file(join(ENGINE, "starter", f)).text();
  let daily = (await starter("workflows/daily.yml")).replace("{{cron}}", cron(String(plan.env.DIGEST_TZ), String(plan.env.CUTOFF), plan.project.days));
  daily = plan.publish === "s3" ? daily.replace(/# publish:(start|end)\n/g, "") : daily.replace(/# publish:start\n[\s\S]*?# publish:end\n/, "");
  await put(".github/workflows/daily.yml", daily);
  // The same bun as the workflows, for anyone whose bun comes from mise.
  await put("mise.toml", await starter("mise.toml"));
  if (plan.publish === "s3") await put(".github/workflows/publish.yml", await starter("workflows/publish.yml"));
  await put("README.md", (await starter("README.md")).replaceAll("{{name}}", plan.project.name).replace("{{publishes}}", plan.publish === "s3" ? "publishes it to the bucket, " : ""));
  return written;
}

// GitHub's cron is UTC: fire at the cutoff's UTC hour in winter and in summer, on the issue days as UTC sees
// them; the workflow's gate lets through the one that is the local cutoff.
export function cron(tz: string, cutoff: string, days?: readonly string[]) {
  const minute = Number(cutoff.split(":")[1]);
  const hours = new Set<number>();
  const utcDays = new Set<number>();
  for (const month of ["01", "07"]) {
    const at = zoned(`2026-${month}-05`, cutoff, tz);
    // A cutoff late or early enough lands on the UTC day before or after the local one.
    const shift = at.getUTCDate() - 5;
    hours.add(at.getUTCHours());
    for (const d of days?.length ? days : DAYS) utcDays.add((DAYS.indexOf(d as Day) + shift + 7) % 7);
  }
  const list = (s: Set<number>) => [...s].sort((a, b) => a - b).join(",");
  return `${minute} ${list(hours)} * * ${utcDays.size === 7 ? "*" : list(utcDays)}`;
}

// What's left for the person: the secrets and variables the workflows need, and the first commands.
export function nextSteps(plan: Plan) {
  const lines = [
    "In the data repo's GitHub settings (Settings → Secrets and variables → Actions):",
    ...plan.secrets.map((s) => `  secret   ${s.name}: ${s.why}`),
    ...Object.entries(plan.vars).map(([k, v]) => `  variable ${k}${v ? ` = ${v}` : ""}`),
    "",
    `Then: cd ${plan.dir}`,
    "  bunx daily-token doctor                      check the setup",
    "  bunx daily-token project cartographer        draw the project's map, then --accept it",
    "  bunx daily-token project brief               draft what the project is and its words, then --accept it",
    "  bunx daily-token run --date <yesterday>      make a first issue locally",
    "  bunx daily-token preview                     read it on :5173",
  ];
  if (reposOf(plan.project).length) lines.push("", `Sources: GitHub ${reposOf(plan.project).join(", ")}`);
  return lines.join("\n");
}

export async function init(dir: string, p: Prompter) {
  const plan = await ask(dir, p);
  const written = await scaffold(plan);
  return { plan, written };
}
