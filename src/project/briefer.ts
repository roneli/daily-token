import { join } from "node:path";
import { type Brief, readBrief } from "../brief";
import { refine } from "../harness/loop";
import type { ProjectCollector, ProjectCtx } from "../harness/plugin";
import { errorsOf, agentSchema, load } from "../harness/schema";
import { type Data, type DataV1, githubOf, issueDates, readJson, reposOf, writeJson } from "../issue";
import { rest } from "../sources/github/collect";

// The Briefer drafts brief.json from what the project already says about itself: READMEs, glossaries,
// overviews, agent instructions, and the docs project.json names. It writes brief.proposed.json; --accept puts
// it in place. Every name and term must appear in what it read, so the brief can't make words up.

type Doc = { from: string; text: string };
type Proposal = { brief: Brief; notes: { change: string; why: string }[] };

const PER_DOC = 12_000;
const TOTAL = 120_000;
const MAX_DOCS = 24;

const DOC_NAME = /^(readme|glossary|brief|overview|architecture|about|concepts|terminology|claude|agents)([.-][\w-]+)?\.(md|mdx|markdown|txt|rst)$/i;

// The repo files worth reading, most telling first: a glossary or brief, then the root README, then the rest by depth.
export function docPaths(paths: string[]): string[] {
  const rank = (p: string) => {
    const base = p.split("/").at(-1) ?? p;
    const depth = p.split("/").length - 1;
    const named = /^(glossary|brief|terminology|concepts)/i.test(base) ? 0 : /^readme/i.test(base) && depth === 0 ? 1 : 2;
    return named * 10 + depth;
  };
  return paths
    .filter((p) => p.split("/").length <= 3 && DOC_NAME.test(p.split("/").at(-1) ?? "") && !/(^|\/)(node_modules|vendor|third_party|\.github)\//.test(p))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// Names, their other names, and terms that appear nowhere in what was read.
export function ungrounded(brief: Brief, read: string): string[] {
  const text = read.toLowerCase();
  const errors: string[] = [];
  const seen = new Set<string>();
  const words = [...brief.names.flatMap((n) => [n.name, ...(n.aka ?? [])]), ...brief.terms.map((t) => t.term)];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) errors.push(`"${w}" is listed twice; keep one entry`);
    seen.add(key);
    if (!text.includes(key)) errors.push(`"${w}" appears in none of the docs or recent PRs; drop it or use the word they use`);
  }
  return errors;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);

async function repoFile(repo: string, path: string): Promise<string | undefined> {
  const r = await rest<{ content?: string; encoding?: string }>(`repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
  return r.content && r.encoding === "base64" ? Buffer.from(r.content, "base64").toString("utf8") : undefined;
}

async function gather(ctx: ProjectCtx): Promise<Doc[]> {
  const docs: Doc[] = [];
  let total = 0;
  const add = (from: string, text: string | undefined) => {
    if (!text?.trim() || total >= TOTAL || docs.length >= MAX_DOCS || docs.some((d) => d.from === from)) return;
    const body = clip(text, Math.min(PER_DOC, TOTAL - total));
    docs.push({ from, text: body });
    total += body.length;
  };
  // The docs project.json names come first: someone chose them.
  for (const d of ctx.project.brief?.docs ?? []) {
    const m = d.match(/^([\w.-]+\/[\w.-]+):(.+)$/);
    if (m) add(d, await repoFile(m[1], m[2]));
    else {
      const file = Bun.file(join(ctx.root, d));
      if (!(await file.exists())) throw new Error(`project.json brief.docs: ${d} isn't in the data root`);
      add(d, await file.text());
    }
  }
  for (const repo of reposOf(ctx.project)) {
    const { tree } = await rest<{ tree: { path: string; type: string }[] }>(`repos/${repo}/git/trees/HEAD?recursive=1`);
    for (const path of docPaths(tree.filter((e) => e.type === "blob").map((e) => e.path))) {
      if (total >= TOTAL || docs.length >= MAX_DOCS) break;
      add(`${repo}:${path}`, await repoFile(repo, path));
    }
  }
  return docs;
}

// The last issues' PR titles and bodies: the words the work actually uses.
async function recent(root: string, days: number) {
  const prs: { ref: string; title: string; body: string }[] = [];
  for (const d of (await issueDates(root)).slice(-days)) {
    const file = Bun.file(join(root, "issues", d, "data.json"));
    if (!(await file.exists())) continue;
    const gh = githubOf((await file.json()) as Data | DataV1);
    for (const p of gh.prs) prs.push({ ref: `${(p.repo ?? gh.repo).split("/")[1] ?? ""}#${p.number}`, title: p.title, body: p.body ?? "" });
  }
  return prs;
}

async function draft(ctx: ProjectCtx, days: number) {
  const [docs, prs, current] = await Promise.all([gather(ctx), recent(ctx.root, days), readBrief(ctx.root)]);
  ctx.log(`${docs.length} docs (${docs.map((d) => d.from).join(", ") || "none"}), ${prs.length} recent PRs`);
  if (!docs.length && !prs.length) throw new Error("nothing to read: no docs in the repos or brief.docs, and no issues yet");
  const read = [...docs.map((d) => d.text), ...prs.flatMap((p) => [p.title, p.body])].join("\n");

  const { value } = await refine<Proposal>({
    model: ctx.model,
    author: "briefer",
    input: { project: { name: ctx.project.name }, current, parts: ctx.system.parts.map((p) => ({ id: p.id, name: p.name, what: p.what })), docs, recent: prs.map((p) => ({ ref: p.ref, title: p.title })) },
    schema: await agentSchema("briefer"),
    gates: [{ name: "grounded", run: async (p) => ({ errors: ungrounded(p.brief, read) }) }],
    rounds: 1,
    trace: ctx.trace,
    log: ctx.log,
  });
  const brief: Brief = { ...value.brief, from: docs.map((d) => d.from) };
  await writeJson(join(ctx.root, "brief.proposed.json"), brief);
  for (const n of value.notes) console.log(`- ${n.change} (${n.why})`);
  ctx.log(`${brief.names.length} names, ${brief.terms.length} terms → ${join(ctx.root, "brief.proposed.json")}; edit it if you like, then --accept`);
}

export const briefer: ProjectCollector = {
  name: "brief",
  options: { days: { type: "string", default: "10" }, accept: { type: "boolean", default: false } },
  async run(ctx, values) {
    if (!values.accept) return draft(ctx, Number(values.days));
    const from = join(ctx.root, "brief.proposed.json");
    if (!(await Bun.file(from).exists())) throw new Error("no brief.proposed.json; run `daily-token project brief` first");
    // A hand edit that broke the proposal shows now, not at the next issue.
    const errors = errorsOf(await load("brief"), await readJson(from), "brief.proposed.json");
    if (errors.length) throw new Error(errors.join("; "));
    await Bun.write(join(ctx.root, "brief.json"), Bun.file(from));
    await Bun.file(from).delete();
    ctx.log("brief.json replaced by the proposal; the next issue's agents read it");
  },
};
