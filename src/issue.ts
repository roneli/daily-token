import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import type { Storyboard } from "./motion";

// A project is what one digest covers: one or more repos, the first being home.
export type Project = {
  id: string;
  name: string;
  // Each source's config, by source name: "github": { "repos": [...] }
  sources?: Record<string, unknown>;
  // Before sources: the GitHub repos, the first being home
  repos?: string[];
  days?: ("sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat")[];
  // The day an issue also looks back at the seven days ending on it; none, no weekly
  weekly?: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
  // Per stage: rounds, budget, and which reviewers and gates run
  brief?: { docs?: string[] };
  pipeline?: Record<string, { enabled?: boolean; rounds?: number; budgetUsd?: number; reviewers?: string[]; gates?: string[]; parallel?: number; maxShorts?: number; voice?: string; voiceover?: boolean; speed?: number; topic?: string; topics?: string[] }>;
};

// A PR or issue as stories and reels cite it: 123 in the home repo, "name#123" in any other.
// A direct commit: "abc1234" in the home repo, "name@abc1234" in any other.
export type Ref = number | string;

export const repoName = (repo: string) => repo.split("/")[1];
export const refOf = (repo: string | undefined, n: number, home: string): Ref => (!repo || repo === home ? n : `${repoName(repo)}#${n}`);
export const commitRef = (repo: string | undefined, sha: string, home: string): Ref => (!repo || repo === home ? sha.slice(0, 7) : `${repoName(repo)}@${sha.slice(0, 7)}`);
export const refLabel = (ref: Ref) => (typeof ref === "number" ? `#${ref}` : ref);

export type PR = {
  repo?: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  files: string[];
  // System parts whose path globs match a file; optional for issues made before collect
  parts?: string[];
  closes: number[];
  epicPath: Ref[];
  core: boolean;
  author: string;
  coauthors: string[];
  body: string;
  // The changed lines, file by file, cut to a budget; optional for issues collected before it
  diff?: string;
};

// A commit pushed to the default branch that no merged PR carries.
export type Commit = {
  repo: string;
  sha: string;
  title: string;
  url: string;
  at: string;
  additions: number;
  deletions: number;
  files: string[];
  parts: string[];
  closes: number[];
  epicPath: Ref[];
  core: boolean;
  author: string;
  coauthors: string[];
  body: string;
  diff?: string;
};

// An open PR, for what's coming. `isNew`: opened in the window; `active`: updated in it.
export type OpenPR = {
  repo?: string;
  number: number;
  title: string;
  url?: string;
  draft?: boolean;
  review?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  parts?: string[];
  closes?: number[];
  epicPath?: Ref[];
  isNew?: boolean;
  active?: boolean;
  body?: string;
};

// An issue opened or closed in the window. `reason` and `closedBy` are set only for a close inside the window.
export type IssueEvent = {
  repo: string;
  number: number;
  title: string;
  url: string;
  opened: boolean;
  closed: boolean;
  reason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
  closedBy: Ref | null;
  author: string;
  labels: string[];
  epicPath: Ref[];
  subIssues: { total: number; completed: number };
  body: string;
};

// The weekly look back at the seven days ending on the issue, from the week's issues in the archive.
export type Week = {
  from: string;
  to: string;
  days: { date: string; headline: string; prs: number; commits: number; epics: Record<string, number> }[];
  totals: { prs: number; commits: number; issuesClosed: number; tags: number };
  // closedThisWeek is null when the archive has no earlier count to compare with
  epics: { ref: Ref; title: string; closed: number; total: number; closedThisWeek: number | null }[];
  // The week's merged PRs, from the archived issues and today: what the weekly edition's themes may cite
  prs?: WeekPR[];
};
export type WeekPR = { ref: Ref; date: string; title: string; parts: string[]; author: string; epic?: Ref; body: string };

// The issue format: what the templates and the player expect from an issue's JSON. A breaking change bumps it
// and tags the last commit of the old format `format-v<N>`; issues of that format keep rendering with that commit.
// 2: data.json holds each source's slice under `sources`; cards and reels cite `ref`, not `pr`.
// 3: reels.json holds threads, one per story, each of 1–5 shorts; a section no longer names its reel.
export const FORMAT = 4;

// A day of the project's GitHub repos: data.json's sources.github.
export type GithubDay = {
  // The home repo, and every repo the window covered; older issues have only `repo`
  repo: string;
  repos?: string[];
  prs: PR[];
  tags: { repo?: string; name: string; at: string; sha: string }[];
  epics: { repo?: string; number: number; title: string; closed: number; total: number }[];
  // Older issues have no commits and only number and title on open PRs
  commits?: Commit[];
  issues?: IssueEvent[];
  week?: Week;
  openPrs: OpenPR[];
  openPrCount: number;
  // Files no part's globs match: the Cartographer's to-do list
  unmatched?: string[];
};

// What every issue has, whatever its sources.
type Day = { format?: number; engine?: string; edition: "daily" | "weekly"; issue: number; date: string; window: { from: string; to: string } };

export type Data = Day & { sources: { github?: GithubDay } & Record<string, unknown> };

// Format 1 had GitHub's fields at the top. Earlier issues are read for threads, counts and the week, in any format.
export type DataV1 = Day & GithubDay;
const NO_GITHUB: GithubDay = { repo: "", prs: [], tags: [], epics: [], openPrs: [], openPrCount: 0 };
export const githubOf = (data: Data | DataV1): GithubDay => ("sources" in data ? (data.sources.github ?? NO_GITHUB) : data);

export type Card = { ref: Ref; with?: Ref[]; type: string; parts: string[]; headline: string; plain: string; tech: string };

export type Section = {
  id: string;
  story: string;
  title: string;
  dek: string;
  lead: { ref: Ref; label: string; text: string } | null;
  cards: Card[];
};

export type Theme = { title: string; dek: string; refs: Ref[] };

export type Stories = {
  headline: string;
  // Weekly only: the week in a title, a dek and its themes, each with the week's PRs it covers (older issues: points)
  recap?: { title: string; dek: string; points?: string[]; themes?: Theme[] };
  sections: Section[];
  rail: { check: string; connects: string };
  parts?: Record<string, string>;
};

// One short: one idea on screen, 6–12 s.
export type Short = {
  id: string;
  template: string;
  seg: string;
  desk: string;
  epic: Ref[];
  headline: string;
  caption: string;
  why: string;
  refs: Ref[];
  ms: number;
  fields: Record<string, unknown>;
};

// A thread is one story's shorts: its id is the section's, or "recap" for the week and "next" for what's coming.
export type Thread = { id: string; name: string; shorts: Short[] };
export type Reels = { threads: Thread[] };

// Every short in play order, with its thread's id.
export const shortsOf = (reels: Reels) => reels.threads.flatMap((t) => t.shorts.map((s) => ({ ...s, thread: t.id })));

type Box = [x: number, y: number, w: number, h: number];
export type Part = { id: string; name: string; sub: string; what: string; box: Box; paths?: string[]; core?: boolean };
export type System = {
  size: [w: number, h: number];
  ignore?: string[];
  groups: { label: string; kind: "zone" | "frame"; box: Box; members?: string[]; parent?: string }[];
  parts: Part[];
  edges: { d: string; label: string; at: [x: number, y: number]; anchor?: "start" | "middle" | "end"; dashed?: boolean; from?: string; to?: string }[];
};

// motion: the Cutaway's storyboard, when the edition has one.
export type Issue = { root: string; dir: string; project: Project; data: Data; stories: Stories; reels: Reels; system: System; motion?: Storyboard };

export const ENGINE = join(import.meta.dir, "..");
// The engine's version, recorded in each data.json: an issue of an older format renders with that version.
export const engineVersion = async () => (await readJson<{ version: string }>(join(ENGINE, "package.json"))).version;

// The project's GitHub repos, the first being home: refs there are cited by number alone.
export const reposOf = (project: Project): string[] => (project.sources?.github as { repos?: string[] } | undefined)?.repos ?? project.repos ?? [];

export const readJson = async <T>(path: string): Promise<T> => (await Bun.file(path).json()) as T;
// Every JSON file the engine writes into a data root has the same shape: one-space indent, a final newline.
export const writeJson = (path: string, value: unknown) => Bun.write(path, `${JSON.stringify(value, null, 1)}\n`);

export const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; see .env.example`);
  return v;
};

// The issue folders under a data root, oldest first. Anything that isn't a date (a stray file, a note) is skipped.
export const issueDates = async (root: string) =>
  (await readdir(join(root, "issues")).catch(() => [] as string[])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

// A data root holds one project's material, outside this repo:
//   <root>/project.json         its id, name and repos
//   <root>/system.json          its parts, for the Digest and the Blueprint
//   <root>/issues/<date>/       data.json, stories.json, reels.json
// DATA_DIR points at it; without it the commands use the made-up fixture.
// The data root when --root doesn't say: DATA_DIR, else the current folder when it holds a project, else the fixture.
// The data root you stand in, else DATA_DIR, else the made-up fixture.
export async function defaultRoot() {
  if (await Bun.file("project.json").exists()) return ".";
  return process.env.DATA_DIR || join(ENGINE, "fixtures", "sample");
}

export async function issueArgs(extra: NonNullable<ParseArgsConfig["options"]> = {}) {
  const { values: parsed } = parseArgs({ options: { root: { type: "string", default: await defaultRoot() }, date: { type: "string" }, out: { type: "string", default: "out" }, ...extra } });
  const values = parsed as Record<string, string | boolean | undefined>;
  const root = values.root as string;
  const date = (values.date as string | undefined) ?? (await issueDates(root)).at(-1);
  if (!date) throw new Error(`no issues under ${root}/issues`);
  return { root, date, out: values.out as string, values };
}

export async function loadIssue(root: string, date: string): Promise<Issue> {
  const dir = join(root, "issues", date);
  const [project, data, stories, reels, system] = await Promise.all([
    readJson<Project>(join(root, "project.json")),
    readJson<Data>(join(dir, "data.json")),
    readJson<Stories>(join(dir, "stories.json")),
    readJson<Reels>(join(dir, "reels.json")),
    readJson<System>(join(root, "system.json")),
  ]);
  const motion = join(dir, "motion.json");
  return { root, dir, project, data, stories, reels, system, ...((await Bun.file(motion).exists()) ? { motion: await readJson<Storyboard>(motion) } : {}) };
}
