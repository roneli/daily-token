import { repoFile, repoTree } from "./sources/github/files";
import type { System } from "./issue";

// What the Explainer may read beyond the map and the brief: the docs and code of the parts its tour is about, from
// the repos, within a budget. Kept in the issue as sources.json, so check and the Viewer hold the tour to them too.

export type Excerpt = { part: string; from: string; text: string };
export type Reader = (o: { system: System; repos: string[]; topic?: string; touched: string[] }) => Promise<Excerpt[]>;

const MAX_PARTS = 4;
const FILES_A_PART = 6;
const PER_FILE = 6_000;
const TOTAL = 48_000;

const COMMON = new Set(["about", "after", "also", "does", "each", "every", "from", "gets", "have", "into", "its", "makes", "more", "only", "over", "that", "their", "them", "then", "there", "they", "this", "through", "what", "when", "where", "which", "while", "with", "without", "your"]);
// Words of four letters or more, a plural's s dropped, so "credentials" meets "credential".
export const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !COMMON.has(w)).map((w) => w.replace(/s$/, "")));

// The parts to read: those the topic's words name, most first; without a topic, or none named, those today's
// changes touched, core first.
export function partsFor(system: System, topic: string | undefined, touched: string[]): string[] {
  if (topic) {
    const want = words(topic);
    const named = system.parts
      .map((p) => ({ id: p.id, hits: [...words(`${p.name} ${p.sub ?? ""} ${p.what ?? ""}`)].filter((w) => want.has(w)).length }))
      .filter((p) => p.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    if (named.length) return named.slice(0, MAX_PARTS).map((p) => p.id);
  }
  return system.parts
    .filter((p) => touched.includes(p.id))
    .sort((a, b) => Number(b.core === true) - Number(a.core === true))
    .slice(0, MAX_PARTS - 1)
    .map((p) => p.id);
}

const TEXT = /\.(md|mdx|ts|tsx|js|mjs|go|rs|py|rb|java|kt|swift|cs|c|h|cc|cpp|proto|sql|ya?ml|toml)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|gen|generated|__snapshots__|testdata|fixtures|migrations)\/|[._-](test|spec)\.|\.d\.ts$|\.min\./i;

// A part's files, most telling first: those whose path names the topic, a rare word of it counting more than a
// common one (a word in every other path tells little), then the part's docs, then the rest, shallowest first.
export function filesFor(paths: string[], globs: string[], topic?: string): string[] {
  const matchers = globs.map((g) => new Bun.Glob(g));
  const want = topic ? words(topic) : new Set<string>();
  const mine = paths.filter((p) => TEXT.test(p) && !SKIP.test(p) && matchers.some((m) => m.match(p)));
  const named = new Map(mine.map((p) => [p, [...words(p.replace(/[/_.:$-]/g, " "))].filter((w) => want.has(w))]));
  const seen = new Map<string, number>();
  for (const ws of named.values()) for (const w of ws) seen.set(w, (seen.get(w) ?? 0) + 1);
  const score = (p: string) => (named.get(p) ?? []).reduce((n, w) => n + Math.log(1 + mine.length / (seen.get(w) ?? 1)), 0);
  const doc = (p: string) => (/\.mdx?$/i.test(p) ? 0 : 1);
  return mine.sort((a, b) => score(b) - score(a) || doc(a) - doc(b) || a.split("/").length - b.split("/").length || a.length - b.length);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);

// Globs match the home repo's paths as written and another repo's as "name:path", as collect maps PRs to parts.
export function readerOf(tree = repoTree, file = repoFile): Reader {
  return async ({ system, repos, topic, touched }) => {
    const ids = partsFor(system, topic, touched);
    if (!ids.length) return [];
    const home = repos[0];
    const paths: string[] = [];
    for (const repo of repos) for (const p of await tree(repo)) paths.push(repo === home ? p : `${repo.split("/")[1]}:${p}`);
    const out: Excerpt[] = [];
    let total = 0;
    const share = Math.floor(TOTAL / ids.length);
    for (const id of ids) {
      const part = system.parts.find((p) => p.id === id);
      let used = 0;
      for (const path of filesFor(paths, part?.paths ?? [], topic).slice(0, FILES_A_PART)) {
        if (used >= share || total >= TOTAL) break;
        const [name, rest] = path.includes(":") ? path.split(/:(.*)/s) : [undefined, path];
        const repo = name ? (repos.find((r) => r.endsWith(`/${name}`)) ?? home) : home;
        const text = await file(repo, rest);
        if (!text?.trim()) continue;
        const body = clip(text, Math.min(PER_FILE, share - used, TOTAL - total));
        out.push({ part: id, from: `${repo}:${rest}`, text: body });
        used += body.length;
        total += body.length;
      }
    }
    return out;
  };
}

export const readRepos = readerOf();
