#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { today } from "./time";
import { createCtx, type StageConfig } from "./harness/context";
import type { Prompter } from "./harness/plugin";
import { claudeCli } from "./harness/model";
import { run } from "./harness/runner";
import { defaultRoot, ENGINE, issueDates, type Project, readJson, type System, writeJson } from "./issue";
import { daily } from "./pipeline";

// daily-token: every command the engine has, run from a data root (or --root / DATA_DIR).

const HELP = `daily-token <command> [options]

  run       Make one day's issue: collect → stories → reels → motion → verify
            --date D  --cutoff HH:MM  --from STAGE  --to STAGE  --rounds N  --set stage.key=value
            --motion / --no-motion  make a Cutaway; unset, a terminal asks and CI reads pipeline.motion.enabled
  cutaway   Make the Cutaway alone on the latest issue: "TOPIC" [--date D] [--force to replace one]
  collect   Collect one day alone to data.json (--force to redo a draft)
  replay    Make one stage of a past issue again in a scratch root and compare: STAGE --date D --set stage.key=value
  project   Run a project collector: cartographer | brief [--days N] [--accept]
  render    Render issues to out/ (--all, --dates a,b)
  check     Validate an issue (--look measures it in a browser)
  init      Set up a data root here or in DIR, or bring one up to date; --yes takes flags instead of questions:
            --name --id --sources github --repos a/b,c/d --tz --cutoff --days mon,tue --weekly fri --model --publish none|s3
  migrate   Bring a data root to the current format; the words don't change (--dry-run lists the files)
  doctor    Check that the data root, its sources, the claude CLI and publishing are ready
  publish   Make the issues bucket match the data root and out/ (--announce DATE, --dry-run)
  preview   Render every issue and serve out/ on :5173
  serve     Serve the site from the issues bucket (--port 8787, --host 127.0.0.1)
  github-app  Make the GitHub App readers sign in with, and put its keys in .env (--site URL, --org NAME)
  deploy    Put the site on Cloudflare from .env: the bucket, the Worker on its domain, the sign-in (--dry-run)

  --root DIR  the data root; default: the current folder if it has project.json, else DATA_DIR`;

// "--set reels.reviewers=[]" → { reels: { reviewers: [] } }. A value that isn't JSON is a string.
export function settings(pairs: string[]): Record<string, StageConfig> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const pair of pairs) {
    const m = pair.match(/^([\w-]+)\.(\w+)=(.*)$/);
    if (!m) throw new Error(`--set takes stage.key=value, not ${pair}`);
    let value: unknown = m[3];
    try {
      value = JSON.parse(m[3]);
    } catch {}
    out[m[1]] = { ...out[m[1]], [m[2]]: value };
  }
  return out as Record<string, StageConfig>;
}

async function runDaily(argv: string[]) {
  const tz = process.env.DIGEST_TZ ?? "UTC";
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      root: { type: "string", default: await defaultRoot() },
      date: { type: "string", default: today(tz) },
      cutoff: { type: "string", default: process.env.CUTOFF ?? "00:00" },
      from: { type: "string" },
      to: { type: "string" },
      rounds: { type: "string" },
      set: { type: "string", multiple: true, default: [] },
      motion: { type: "boolean" },
    },
  });
  const set = settings(values.set);
  if (values.rounds) for (const s of daily) set[s.name] = { rounds: Number(values.rounds), ...set[s.name] };
  const ctx = await createCtx({ root: values.root, date: values.date, cutoff: values.cutoff, tz, model: claudeCli, set });
  // The motion is asked for per edition, only when this run reaches its stage.
  const names = daily.map((s) => s.name);
  const at = names.indexOf("motion");
  if (names.indexOf(values.from ?? names[0]) <= at && at <= names.indexOf(values.to ?? names.at(-1) ?? "")) {
    const { askMotion, queued, wantMotion } = await import("./stages/motion");
    // A topic waiting in the queue turns the Cutaway on.
    const waiting = await queued(ctx.root, ctx.date, ctx.pipeline.motion?.topics);
    const enabled = await wantMotion({ flag: values.motion ?? set.motion?.enabled, configured: ctx.pipeline.motion?.enabled || waiting !== undefined, ask: process.stdin.isTTY ? () => askMotion(waiting) : undefined });
    ctx.pipeline.motion = { ...ctx.pipeline.motion, enabled };
  }
  const { meta, costUsd } = await run(ctx, daily, { from: values.from, to: values.to });
  console.log(`${ctx.runs.length} agent runs, $${costUsd.toFixed(2)}`);
  if ((meta.check as { errors: string[] } | undefined)?.errors.length) process.exitCode = 1;
}

// cutaway "TOPIC": the Cutaway alone, on the latest issue or --date, touring that topic; then that issue renders again.
async function runCutaway(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { root: { type: "string", default: await defaultRoot() }, date: { type: "string" }, force: { type: "boolean", default: false }, set: { type: "string", multiple: true, default: [] } },
  });
  const topic = positionals.join(" ").trim();
  const has = (date: string, file: string) => Bun.file(join(values.root, "issues", date, file)).exists();
  const date = values.date ?? (await issueDates(values.root)).at(-1);
  if (!date) throw new Error("no issue to add a Cutaway to; make one with `daily-token run`");
  if (!(await has(date, "reels.json"))) throw new Error(`issue ${date} has no digest and reels yet; make it with \`daily-token run --date ${date}\``);
  if ((await has(date, "motion.json")) && !values.force) throw new Error(`issue ${date} has a Cutaway already; --force replaces it`);
  const set = settings(values.set);
  set.motion = { ...set.motion, enabled: true, ...(topic ? { topic } : {}) };
  const ctx = await createCtx({ root: values.root, date, cutoff: process.env.CUTOFF ?? "00:00", tz: process.env.DIGEST_TZ ?? "UTC", model: claudeCli, set });
  console.log(`[cutaway] issue ${date}${topic ? `: ${topic}` : ""}`);
  const { meta, costUsd } = await run(ctx, daily, { from: "motion" });
  console.log(`${ctx.runs.length} agent runs, $${costUsd.toFixed(2)}`);
  if ((meta.check as { errors: string[] } | undefined)?.errors.length) process.exitCode = 1;
  else if (await has(date, "motion.json")) {
    await script("render", ["--root", values.root, "--dates", date]);
    console.log("watch it: daily-token preview, then the issue's Cutaway tab");
  }
}

async function runReplay(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { root: { type: "string", default: await defaultRoot() }, date: { type: "string" }, set: { type: "string", multiple: true, default: [] } },
  });
  const stage = positionals[0];
  if (!stage || !values.date) throw new Error("replay STAGE --date D [--set stage.key=value ...]");
  const { replay, table } = await import("./replay");
  const r = await replay({ root: values.root, date: values.date, stage, set: settings(values.set), model: claudeCli, tz: process.env.DIGEST_TZ, cutoff: process.env.CUTOFF });
  console.log(`\n${table(stage, values.set, r.before, r.after)}\n\nreplayed issue: ${r.scratch}`);
}

async function runProject(argv: string[]) {
  const { PROJECT_COLLECTORS } = await import("./project");
  const collector = PROJECT_COLLECTORS.find((c) => c.name === argv[0]);
  if (!collector) throw new Error(`project takes a collector: ${PROJECT_COLLECTORS.map((c) => c.name).join(", ")}`);
  const { values } = parseArgs({ args: argv.slice(1), options: { root: { type: "string", default: await defaultRoot() }, ...collector.options } });
  const root = values.root as string;
  const [project, system] = await Promise.all([readJson<Project>(join(root, "project.json")), readJson<System>(join(root, "system.json"))]);
  const log = (msg: string) => console.log(`[${collector.name}] ${msg}`);
  const trace = (name: string, value: unknown) => writeJson(join(root, "trace", collector.name, `${name}.json`), value);
  await collector.run({ root, project, system, model: claudeCli, log, trace }, values);
}

export async function runInit(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      yes: { type: "boolean", default: false },
      install: { type: "boolean", default: true },
      "gh-token": { type: "boolean", default: false },
      ...Object.fromEntries(["name", "id", "sources", "repos", "tz", "cutoff", "days", "weekly", "model", "publish", "site"].map((k) => [k, { type: "string" as const }])),
    },
  });
  const dir = positionals[0] ?? ".";
  const flags = values as Record<string, string | boolean | undefined>;
  const { init, nextSteps } = await import("./init");
  let p: Prompter;
  if (values.yes) {
    const { answering } = await import("./prompter");
    const answers: Record<string, string | boolean> = { migrate: true, "github.useGhToken": values["gh-token"] as boolean };
    for (const k of ["name", "id", "sources", "tz", "cutoff", "days", "weekly", "model", "publish", "site"]) if (typeof flags[k] === "string") answers[k] = flags[k];
    if (typeof flags.repos === "string") answers["github.repos"] = flags.repos;
    p = answering(answers);
  } else {
    const clack = await import("@clack/prompts");
    clack.intro("The Daily Token");
    p = (await import("./prompter")).terminal;
  }
  const { plan, written } = await init(dir, p);
  console.log(`\nwrote ${written.join(", ")} in ${dir}`);
  if (values.install) {
    const r = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "inherit", stderr: "inherit" });
    if (!r.success) console.log("bun install failed; run it in the data root before the commands below");
  }
  console.log(`\n${nextSteps(plan)}`);
  // Asked, the site goes online now: the GitHub App in the browser, then the Worker. Each reads the data root's .env.
  if (!values.yes && plan.vars.SITE_URL) {
    const clack = await import("@clack/prompts");
    const now = await clack.confirm({ message: `Put the site online at ${plan.vars.SITE_URL} now? This makes a GitHub App for the sign-in, then deploys to Cloudflare`, initialValue: true });
    if (now === true)
      for (const command of ["github-app", "deploy"]) {
        const r = Bun.spawnSync(["bun", join(ENGINE, "src", "cli.ts"), command], { cwd: dir, stdio: ["inherit", "inherit", "inherit"] });
        if (!r.success) {
          console.log(`${command} stopped; run \`daily-token ${command}\` in the data root to try again`);
          break;
        }
      }
  }
}

// collect alone refuses to overwrite: a published issue's data doesn't change.
async function runCollect(argv: string[]) {
  const tz = process.env.DIGEST_TZ ?? "UTC";
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: "string", default: await defaultRoot() }, date: { type: "string", default: today(tz) }, cutoff: { type: "string", default: process.env.CUTOFF ?? "00:00" }, force: { type: "boolean", default: false } },
  });
  const ctx = await createCtx({ root: values.root, date: values.date, cutoff: values.cutoff, tz, model: claudeCli });
  if (!values.force && (await ctx.has("data.json"))) throw new Error(`${ctx.at("data.json")} exists; published issues don't change (--force to redo a draft)`);
  await run(ctx, daily, { from: "collect", to: "collect" });
}

// The commands that are scripts of their own run as they are, with the engine's copy of them.
async function script(name: string, argv: string[]) {
  const root = argv.includes("--root") ? [] : ["--root", await defaultRoot()];
  const proc = Bun.spawn(["bun", join(ENGINE, "src", `${name}.ts`), ...root, ...argv], { stdio: ["inherit", "inherit", "inherit"] });
  process.exitCode = await proc.exited;
}

async function main(command: string, argv: string[]) {
  switch (command) {
    case "run":
      await runDaily(argv[0] === "daily" ? argv.slice(1) : argv);
      break;
    case "cutaway":
      await runCutaway(argv);
      break;
    case "replay":
      await runReplay(argv);
      break;
    case "project":
      await runProject(argv);
      break;
    case "init":
      await runInit(argv);
      break;
    case "migrate": {
      const { values } = parseArgs({ args: argv, options: { root: { type: "string", default: await defaultRoot() }, "dry-run": { type: "boolean", default: false } } });
      const { migrate } = await import("./migrate");
      const changed = await migrate(values.root, { dryRun: values["dry-run"] });
      for (const f of changed) console.log(`${values["dry-run"] ? "would convert" : "converted"} ${f}`);
      console.log(changed.length ? `${changed.length} files` : "already the current format");
      break;
    }
    case "doctor": {
      const { values } = parseArgs({ args: argv, options: { root: { type: "string", default: await defaultRoot() } } });
      const { doctor } = await import("./doctor");
      const found = await doctor(values.root);
      for (const f of found) console.log(`${f.ok ? "✓" : "✗"} ${f.what}${f.detail ? `: ${f.detail}` : ""}`);
      if (found.some((f) => !f.ok)) process.exitCode = 1;
      break;
    }
    case "collect":
      await runCollect(argv);
      break;
    case "render":
    case "check":
    case "publish":
    case "preview":
    case "serve":
    case "github-app":
    case "deploy":
      await script(command, argv);
      break;
    default:
      console.log(HELP);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  try {
    await main(command, argv);
  } catch (e) {
    // What went wrong in one line; DEBUG=1 shows where.
    console.error(`error: ${(e as Error).message ?? e}`);
    if (process.env.DEBUG) console.error((e as Error).stack);
    process.exitCode = 1;
  }
  // A finished run exits even if a child Bun lost track of still holds the event loop.
  if (["run", "cutaway", "replay", "project"].includes(command)) process.exit();
}
