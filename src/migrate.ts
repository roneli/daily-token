import { join } from "node:path";
import { type DataV1, engineVersion, FORMAT, issueDates, type Project, readJson, writeJson } from "./issue";

// migrate: a data root brought to the current format. Only the shape changes: every word, number and ref stays.
// Format 1 → 2: GitHub's fields move under data.sources.github, cards, leads and reels cite `ref`/`refs`,
// and project.json's repos become sources.github.
// Format 2 → 3: reels group into threads by their section, in order; a story that had no reel gets one `title`
// short in its own words; sections lose `reel`.
// Format 3 → 4: the weekly edition is `weekly`, not `thursday`, and project.json names its day, Thursday as before.

const COMMON = new Set(["format", "engine", "edition", "issue", "date", "window"]);

function renamed<T extends Record<string, unknown>>(o: T, from: string, to: string): T {
  if (!(from in o)) return o;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v])) as T;
}

type Json = Record<string, unknown>;

export function storiesV2(s: Json): Json {
  const sections = (s.sections as Json[]).map((x) => ({ ...x, lead: x.lead && renamed(x.lead as Json, "pr", "ref"), cards: (x.cards as Json[]).map((c) => renamed(c, "pr", "ref")) }));
  return { ...s, sections };
}

export function reelsV2(r: Json): Json {
  const reels = (r.reels as Json[]).map((x) => {
    const reel = renamed(x, "prs", "refs");
    const fields = { ...(reel.fields as Json) };
    for (const key of ["events", "metrics"]) if (Array.isArray(fields[key])) fields[key] = (fields[key] as Json[]).map((i) => renamed(i, "pr", "ref"));
    return { ...reel, fields };
  });
  return { ...r, reels };
}

// A thread's circle name from the section's story slug: "launch-pad" → "launch pad", cut at a word to 14.
function circleName(story: string) {
  const words = story.split("-");
  let name = "";
  for (const w of words) if (`${name} ${w}`.trim().length <= 14) name = `${name} ${w}`.trim();
  return name || story.slice(0, 14);
}

export function threadsV3(stories: Json, reels: Json): { stories: Json; reels: Json } {
  const sections = stories.sections as (Json & { id: string; story: string; title: string; dek: string; cards: Json[] })[];
  const old = reels.reels as (Json & { id: string; section: string })[];
  const strip = ({ section: _s, ...short }: Json) => short;
  for (const r of old) if (r.section !== "recap" && !sections.some((s) => s.id === r.section)) throw new Error(`reel ${r.id} belongs to section ${r.section}, which doesn't exist`);
  const threads: Json[] = [];
  const recap = old.filter((r) => r.section === "recap");
  if (recap.length) threads.push({ id: "recap", name: "This week", shorts: recap.map(strip) });
  for (const s of sections) {
    const mine = old.filter((r) => r.section === s.id);
    const refs = [...new Set(s.cards.flatMap((c) => [c.ref, ...((c.with as unknown[]) ?? [])]))];
    const shorts = mine.length ? mine.map(strip) : [{ id: `${s.id}-title`, template: "title", seg: s.story.slice(0, 16), desk: "", epic: [], headline: s.title, caption: s.dek, why: "", refs, ms: 6000, fields: { title: s.title, dek: s.dek } }];
    threads.push({ id: s.id, name: circleName(s.story), shorts });
  }
  return { stories: { ...stories, sections: sections.map(({ reel: _r, ...s }) => s) }, reels: { threads } };
}

export function dataV2(d: DataV1, engine: string): Json {
  const github = Object.fromEntries(Object.entries(d).filter(([k]) => !COMMON.has(k)));
  return { format: 2, engine, edition: d.edition, issue: d.issue, date: d.date, window: d.window, sources: { github } };
}

export async function migrate(root: string, opts: { dryRun?: boolean } = {}) {
  const changed: string[] = [];
  const write = async (path: string, value: unknown) => {
    changed.push(path);
    if (!opts.dryRun) await writeJson(path, value);
  };
  const projectFile = join(root, "project.json");
  const { repos, ...project } = await readJson<Project>(projectFile);
  if (repos && !project.sources) await write(projectFile, { ...project, sources: { github: { repos } } });

  const engine = await engineVersion();
  let older = false;
  for (const date of await issueDates(root)) {
    const dir = join(root, "issues", date);
    const file = Bun.file(join(dir, "data.json"));
    if (!(await file.exists())) continue;
    let data = (await file.json()) as Json;
    const format = (data.format as number | undefined) ?? 1;
    if (format >= FORMAT) continue;
    const read = async (name: string) => {
      const f = Bun.file(join(dir, name));
      return (await f.exists()) ? ((await f.json()) as Json) : undefined;
    };
    let [stories, reels] = [await read("stories.json"), await read("reels.json")];
    if (format < 2) {
      data = dataV2(data as DataV1, engine);
      stories &&= storiesV2(stories);
      reels &&= reelsV2(reels);
    }
    if (format < 3 && stories && reels) ({ stories, reels } = threadsV3(stories, reels));
    if (data.edition === "thursday") data = { ...data, edition: "weekly" };
    older = true;
    await write(join(dir, "data.json"), { ...data, format: FORMAT });
    if (format < 3 && stories) await write(join(dir, "stories.json"), stories);
    if (format < 3 && reels) await write(join(dir, "reels.json"), reels);
  }
  // Before format 4, every Thursday was the weekly edition.
  const now = await readJson<Project>(projectFile);
  if (older && !now.weekly) await write(projectFile, { ...now, weekly: "thu" });
  return [...new Set(changed)];
}
