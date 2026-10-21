import { join } from "node:path";
import { refine } from "../harness/loop";
import type { ProjectCollector } from "../harness/plugin";
import { agentSchema } from "../harness/schema";
import { type Data, type DataV1, githubOf, issueDates, reposOf, type System, writeJson } from "../issue";
import { layout, meaningOf, type SystemMap } from "../layout";
import { partsOf, rest } from "../sources/github/collect";

// The Cartographer proposes system.json from what recent changes touched. It writes system.proposed.json
// and map.json (its notes); --accept puts the proposal in place. Same parts, groups and edges keep the drawn
// geometry; any change to them redraws the map with the layout library.

type Proposal = SystemMap & { ignore: string[]; notes: { change: string; why: string }[] };

async function tree(repo: string, prefix: string) {
  const { tree: entries } = await rest<{ tree: { path: string; type: string }[] }>(`repos/${repo}/git/trees/HEAD?recursive=1`);
  const dirs = new Map<string, number>();
  for (const e of entries.filter((x) => x.type === "blob")) {
    const segs = e.path.split("/");
    const dir = segs.length === 1 ? "(root)" : segs.slice(0, Math.min(3, segs.length - 1)).join("/");
    dirs.set(prefix + dir, (dirs.get(prefix + dir) ?? 0) + 1);
  }
  return [...dirs].map(([dir, files]) => ({ dir, files })).sort((a, b) => a.dir.localeCompare(b.dir));
}

const sameStructure = (a: SystemMap, b: SystemMap) => {
  const key = (m: SystemMap) =>
    JSON.stringify([
      m.parts.map((p) => p.id).sort(),
      m.groups.map((g) => [g.label, [...g.members].sort(), g.parent ?? ""]).sort(),
      m.edges.map((e) => [e.from, e.to, e.dashed ?? false]).sort(),
    ]);
  return key(a) === key(b);
};

async function map(ctx: Parameters<ProjectCollector["run"]>[0], days: number) {
  const { root, project, system } = ctx;
  const current = meaningOf(system);

  const dates = (await issueDates(root)).slice(-days);
  const seen = new Map<string, number>();
  for (const d of dates) {
    const file = Bun.file(join(root, "issues", d, "data.json"));
    if (!(await file.exists())) continue;
    const data = (await file.json()) as Data | DataV1;
    for (const f of githubOf(data).unmatched ?? []) seen.set(f, (seen.get(f) ?? 0) + 1);
  }
  // Files the current map already places (paths may have changed since collect ran) need no answer.
  const unmatched = partsOf([...seen.keys()], system).unmatched;
  const folders = [];
  for (const [i, repo] of reposOf(project).entries()) folders.push(...(await tree(repo, i === 0 ? "" : `${repo.split("/")[1]}:`)));
  ctx.log(`${unmatched.length} unmatched files from ${dates.length} issues, ${folders.length} folders`);

  const validate = (p: Proposal) => {
    const errors: string[] = [];
    const ids = new Set(p.parts.map((x) => x.id));
    if (ids.size !== p.parts.length) errors.push("part ids must be unique");
    const labels = new Set(p.groups.map((g) => g.label));
    for (const g of p.groups) {
      for (const m of g.members) if (!ids.has(m)) errors.push(`group "${g.label}" lists ${m}, which isn't a part`);
      if (g.parent && !labels.has(g.parent)) errors.push(`group "${g.label}" sits in "${g.parent}", which isn't a group`);
    }
    for (const e of p.edges) for (const end of [e.from, e.to]) if (!ids.has(end)) errors.push(`edge "${e.label}" joins ${end}, which isn't a part`);
    const left = partsOf(unmatched, { ...system, parts: p.parts.map((x) => ({ ...x, box: [0, 0, 0, 0] })), ignore: p.ignore }).unmatched;
    if (left.length) errors.push(`${left.length} files still match no part and no ignore glob, e.g. ${left.slice(0, 15).join(", ")}`);
    return errors;
  };

  const { value, runs } = await refine<Proposal>({
    model: ctx.model, author: "cartographer", input: { project, current, unmatched, folders }, schema: await agentSchema("cartographer"),
    gates: [{ name: "structure", run: async (p) => ({ errors: validate(p) }) }], rounds: 1, trace: ctx.trace, log: ctx.log,
  });
  const { notes, ...meaning } = value;
  let proposed: System;
  const kept = sameStructure(current, meaning);
  if (kept) {
    const byId = new Map(meaning.parts.map((p) => [p.id, p]));
    proposed = {
      ...system,
      ignore: meaning.ignore,
      parts: system.parts.map((p) => ({ ...p, ...byId.get(p.id), box: p.box })),
      groups: system.groups.map((g) => ({ ...g, members: meaning.groups.find((x) => x.label === g.label)?.members ?? g.members })),
      edges: system.edges.map((e, i) => ({ ...e, from: current.edges[i].from, to: current.edges[i].to, label: meaning.edges.find((x) => x.from === current.edges[i].from && x.to === current.edges[i].to)?.label ?? e.label })),
    };
  } else proposed = await layout(meaning);

  await writeJson(join(root, "system.proposed.json"), proposed);
  await writeJson(join(root, "map.json"), { kept, notes, runs });
  for (const n of notes) console.log(`- ${n.change} (${n.why})`);
  ctx.log(`${kept ? "same structure: the drawn layout is kept" : "the structure changed: the map was redrawn by the layout library; compare it before accepting"} → ${join(root, "system.proposed.json")}`);
}

export const cartographer: ProjectCollector = {
  name: "cartographer",
  options: { days: { type: "string", default: "7" }, accept: { type: "boolean", default: false } },
  async run(ctx, values) {
    if (!values.accept) return map(ctx, Number(values.days));
    const from = join(ctx.root, "system.proposed.json");
    await Bun.write(join(ctx.root, "system.json"), Bun.file(from));
    await Bun.file(from).delete();
    ctx.log("system.json replaced by the proposal; run check on the latest issue to confirm its parts still exist");
  },
};
