#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { today } from "./time";
import { createCtx, type StageConfig } from "./harness/context";
import type { Prompter } from "./harness/plugin";
import { claudeCli } from "./harness/model";
import { run } from "./harness/runner";
import { defaultRoot, ENGINE, type Project, readJson, type System, writeJson } from "./issue";
import { daily } from "./pipeline";

// daily-token: every command the engine has, run from a data root (or --root / DATA_DIR).

const HELP = `daily-token <command> [options]

  run       Make one day's issue: collect → stories → reels → motion → verify
            --date D  --cutoff HH:MM  --from STAGE  --to STAGE  --rounds N  --set stage.key=value
            --motion / --no-motion  make a Cutaway; unset, a terminal asks and CI reads pipeline.motion.enabled
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
    const { askMotion, wantMotion } = await import("./stages/motion");
    const enabled = await wantMotion({ flag: values.motion ?? set.motion?.enabled, configured: ctx.pipeline.motion?.enabled, ask: process.stdin.isTTY ? askMotion : undefined });
    ctx.pipeline.motion = { ...ctx.pipeline.motion, enabled };
  }
  const { meta, costUsd } = await run(ctx, daily, { from: values.from, to: values.to });
  console.log(`${ctx.runs.length} agent runs, $${costUsd.toFixed(2)}`);
  if ((meta.check as { errors: string[] } | undefined)?.errors.length) process.exitCode = 1;
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
      ...Object.fromEntries(["name", "id", "sources", "repos", "tz", "cutoff", "days", "weekly", "model", "publish"].map((k) => [k, { type: "string" as const }])),
    },
  });
  const dir = positionals[0] ?? ".";
  const flags = values as Record<string, string | boolean | undefined>;
  const { init, nextSteps } = await import("./init");
  let p: Prompter;
  if (values.yes) {
    const { answering } = await import("./prompter");
    const answers: Record<string, string | boolean> = { migrate: true, "github.useGhToken": values["gh-token"] as boolean };
    for (const k of ["name", "id", "sources", "tz", "cutoff", "days", "weekly", "model", "publish"]) if (typeof flags[k] === "string") answers[k] = flags[k];
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

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "run":
      await runDaily(argv[0] === "daily" ? argv.slice(1) : argv);
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
      await script(command, argv);
      break;
    default:
      console.log(HELP);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
  // A finished run exits even if a child Bun lost track of still holds the event loop.
  if (["run", "replay", "project"].includes(command)) process.exit();
}
