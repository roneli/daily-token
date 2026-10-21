import { join } from "node:path";
import { readBrief } from "./brief";
import { errorsOf, load } from "./harness/schema";
import { commitRef, type Data, type DataV1, ENGINE, githubOf, type Issue, issueArgs, issueDates, loadIssue, type Reels, type Ref, readJson, refLabel, refOf, repoName, reposOf, shortsOf } from "./issue";
import { meaningOf } from "./layout";
import { estimated, INSIDE, lengthErrors, type Move, moveOf, type Stop, type Storyboard, timeline } from "./motion";
import { renderIssue } from "./render";
import { scene } from "./scene";
import { voiceOf } from "./voice";

const MAX_SHORT_MS = 12000;
// Viewers skip whole threads, so the issue has no cap; a thread past this, or this many threads, is long.
const LONG_THREAD_MS = 45000;
const MANY_THREADS = 8;

// What an issue may cite: today's PRs and commits (prs), and what its words may mention besides (known):
// earlier issues' PRs, epics, issues, open PRs and what they close. `bodies` holds each citable PR's or commit's
// body, today's and the earlier issues', for quotes.
export async function citable(issue: Pick<Issue, "root" | "project" | "data">) {
  const { data, project } = issue;
  const home = reposOf(project)[0];
  const gh = githubOf(data);
  const commits = gh.commits ?? [];
  const bodies = new Map<Ref, string>();
  for (const p of gh.prs) bodies.set(refOf(p.repo, p.number, home), p.body ?? "");
  for (const c of commits) bodies.set(commitRef(c.repo, c.sha, home), c.body ?? "");
  const prs = new Set<Ref>(bodies.keys());
  const linked = [...gh.prs, ...commits, ...gh.openPrs];
  // Earlier issues' PRs are fair to mention: today's work often builds on them.
  const earlier: Ref[] = [];
  for (const d of (await issueDates(issue.root)).filter((x) => x < data.date).slice(-10)) {
    const file = join(issue.root, "issues", d, "data.json");
    if (!(await Bun.file(file).exists())) continue;
    for (const p of githubOf(await readJson<Data | DataV1>(file)).prs) {
      const ref = refOf(p.repo, p.number, home);
      earlier.push(ref);
      if (!bodies.has(ref)) bodies.set(ref, p.body ?? "");
    }
  }
  const open = new Set<Ref>(gh.openPrs.map((o) => refOf(o.repo, o.number, home)));
  const known = new Set<Ref>([
    ...prs,
    ...earlier,
    ...gh.epics.map((e) => refOf(e.repo, e.number, home)),
    ...open,
    ...(gh.issues ?? []).flatMap((i) => [refOf(i.repo, i.number, home), ...i.epicPath]),
    ...linked.flatMap((p) => [...(p.closes ?? []).map((n) => refOf(p.repo, n, home)), ...(p.epicPath ?? [])]),
  ]);
  return { home, gh, prs, earlier: new Set(earlier), known, open, bodies };
}

// The #123 and name#123 a text mentions, as refs.
export function mentions(text: string, home: string): Ref[] {
  return [...text.matchAll(/(?:^|[\s(])([\w.-]+)?#(\d+)\b/g)].map((m) => (!m[1] || m[1] === repoName(home) ? +m[2] : `${m[1]}#${m[2]}`));
}

// stage "stories" checks the Digest alone, before the Director has made any reels; "thread" checks reels that may
// cover only some stories, as one Director's thread does.
export async function check(issue: Issue, stage: "stories" | "thread" | "all" = "all") {
  const { project, data, stories, reels, system } = issue;
  const all = stage !== "stories";
  const errors: string[] = [];
  const warnings: string[] = [];
  const validate = async (name: string, path: string, value: unknown) => {
    errors.push(...errorsOf(await load(path), value, name));
  };
  const own = (name: string) => join(ENGINE, "schemas", `${name}.schema.json`);
  await validate("stories", own("stories"), stories);
  if (all) await validate("reels", own("reels"), reels);
  await validate("system", own("system"), system);
  await validate("project", own("project"), project);
  const { home, gh, prs, known, open } = await citable(issue);
  if (gh.repo !== home) errors.push(`data.json was collected for ${gh.repo}, but the project's home repo is ${home}`);
  const parts = new Set(system.parts.filter((p) => p.box?.length === 4).map((p) => p.id));
  for (const id of Object.keys(stories.parts ?? {})) if (!parts.has(id)) errors.push(`stories.parts names "${id}", which isn't a part with a box in system.json`);
  const sections = new Set(stories.sections.map((s) => s.id));
  const needRef = (where: string, n: Ref | undefined) => {
    if (n !== undefined && !prs.has(n)) errors.push(`${where} cites ${refLabel(n)}, which is not in data.json${typeof n === "string" && n.startsWith(`${repoName(home)}#`) ? "; cite the home repo's PRs by number" : ""}`);
  };
  const refs = (where: string, text: string) => {
    for (const ref of mentions(text, home)) if (!known.has(ref)) warnings.push(`${where} mentions ${refLabel(ref)}, which data.json doesn't know`);
  };

  if (data.edition === "weekly" && !stories.recap) errors.push("a weekly issue needs a recap of the week");
  if (stories.recap) refs("recap", [stories.recap.dek, ...stories.recap.points].join(" "));

  const carded = new Set<Ref>();
  for (const s of stories.sections) {
    needRef(`section ${s.id} lead`, s.lead?.ref);
    refs(`section ${s.id} dek`, s.dek);
    for (const c of s.cards) {
      needRef(`section ${s.id} card`, c.ref);
      carded.add(c.ref);
      for (const w of c.with ?? []) {
        needRef(`${refLabel(c.ref)} card's with`, w);
        carded.add(w);
      }
      for (const p of c.parts) if (!parts.has(p)) errors.push(`${refLabel(c.ref)} names part "${p}", which isn't a part with a box in system.json`);
      refs(`${refLabel(c.ref)} card`, `${c.plain} ${c.tech}`);
    }
  }
  for (const n of prs) if (!carded.has(n)) errors.push(`${refLabel(n)} landed in the window but no digest card covers it`);
  if (!all) return { errors, warnings };

  // A thread is a story's, or the week's (only with a recap), or what's coming.
  const threads = new Set<string>();
  for (const t of reels.threads) {
    if (threads.has(t.id)) errors.push(`thread ${t.id} appears twice`);
    threads.add(t.id);
    if (!sections.has(t.id) && t.id !== "next" && !(t.id === "recap" && stories.recap)) errors.push(`thread ${t.id} is no section's${t.id === "recap" ? " (only an issue with a recap has a recap thread)" : ""}`);
  }
  if (stage === "all") for (const s of stories.sections) if (!threads.has(s.id)) errors.push(`section ${s.id} has no thread; every story gets one`);
  const ids = new Set<string>();
  for (const r of shortsOf(reels)) {
    if (ids.has(r.id)) errors.push(`reel ${r.id} appears twice; ids are shared by every reel on the page`);
    ids.add(r.id);
    // A reel about what's coming may show open PRs; cards cover only what landed.
    for (const n of r.refs) if (!open.has(n)) needRef(`reel ${r.id}`, n);
    for (const e of r.epic) if (!known.has(e)) warnings.push(`reel ${r.id} names epic ${refLabel(e)}, which data.json doesn't know`);
    refs(`reel ${r.id}`, `${r.caption} ${r.why}`);
    const tpl = join(ENGINE, "templates", "reels", r.template);
    if (!(await Bun.file(`${tpl}.liquid`).exists())) { errors.push(`reel ${r.id} uses template ${r.template}, which doesn't exist`); continue; }
    if (await Bun.file(`${tpl}.schema.json`).exists()) await validate(`reel ${r.id} fields`, `${tpl}.schema.json`, r.fields);
    for (const key of ["events", "metrics"]) for (const item of (r.fields[key] as { ref?: Ref }[] | undefined) ?? []) needRef(`reel ${r.id} ${key}`, item.ref);
    if (r.template === "scene" && typeof r.fields.svg === "string") {
      const s = scene(r.fields.svg);
      for (const e of s.errors) errors.push(`reel ${r.id} scene [${e.code}] ${e.detail}`);
      for (const id of s.ids) if (!id.startsWith(`${r.id}-`)) errors.push(`reel ${r.id} scene [id] "${id}" must start with "${r.id}-"; ids are shared by every reel on the page`);
      refs(`reel ${r.id} scene`, s.text);
    }
  }
  if (stage === "all" && issue.motion) {
    const m = await checkMotion(issue, issue.motion);
    errors.push(...m.errors);
    warnings.push(...m.warnings);
  }
  if (errors.length) return { errors, warnings };

  let rendered: Awaited<ReturnType<typeof renderIssue>>["reels"];
  try {
    ({ reels: rendered } = await renderIssue(issue, { css: "", js: "" }));
  } catch (e) {
    errors.push(`render failed: ${(e as Error).message}`);
    return { errors, warnings };
  }
  const long = new Map<string, number>();
  for (const r of rendered) {
    long.set(r.thread, (long.get(r.thread) ?? 0) + r.ms);
    if (r.ms > MAX_SHORT_MS) errors.push(`reel ${r.id} runs ${r.ms} ms; a reel is at most ${MAX_SHORT_MS}`);
    const last = Math.max(0, ...[...r.svg.matchAll(/data-at="(\d+(?:\.\d+)?)"/g)].map((m) => +m[1]));
    if (last >= r.ms) errors.push(`reel ${r.id} has a cue at ${last} ms but ends at ${r.ms}`);
    for (const m of r.svg.matchAll(/data-el="([^"]+)"/g)) if (!r.svg.includes(`id="${m[1]}"`)) errors.push(`reel ${r.id} cues #${m[1]}, which isn't drawn`);
  }
  for (const [t, ms] of long) if (ms > LONG_THREAD_MS) warnings.push(`thread ${t} runs ${ms} ms; past ${LONG_THREAD_MS / 1000} s each short must earn its place`);
  if (reels.threads.length > MANY_THREADS) warnings.push(`${reels.threads.length} threads; past ${MANY_THREADS} the day reads long, so fold small stories together`);
  return { errors, warnings };
}

// The Cutaway's storyboard against the data (rule 1) and the map: every stop is a part of system.json, reached
// along one of its edges or inside one frame; every PR or commit it marks new is today's; every number, name and
// label it shows is somewhere in the data, the digest, the system map or the brief. And it is a tour, not the
// reels again: it crosses the system, most of its stops aren't today's changes, and it doesn't retell a story.
// `seconds` is its spoken length; without it the length is estimated and only warned about.
export type Recent = { date: string; flow: string; title: string; parts: string[] };
export async function checkMotion(issue: Pick<Issue, "root" | "project" | "data" | "system" | "stories"> & { reels?: Reels }, sb: Storyboard, o: { seconds?: number; how?: string; recent?: Recent[] } = {}) {
  const errors = errorsOf(await load("motion"), sb, "motion");
  const warnings: string[] = [];
  if (errors.length) return { errors, warnings };
  if (o.seconds !== undefined) errors.push(...lengthErrors(o.seconds, o.how));
  else warnings.push(...lengthErrors(timeline(sb, estimated(sb, voiceOf(issue.project.pipeline?.motion).speed).seconds).seconds, "as its words will be spoken").map((e) => `${e}; the voice decides, and its beats are fitted`));
  const { home, prs, known, gh } = await citable(issue);
  const map = meaningOf(issue.system);
  const parts = new Set(map.parts.map((p) => p.id));
  const frameOf = (id: string) => map.groups.find((g) => g.kind === "frame" && g.members.includes(id))?.label;
  for (const [i, s] of sb.stops.entries()) {
    const where = `motion stop ${i + 1} (${s.part})`;
    if (!parts.has(s.part)) {
      errors.push(`${where}: "${s.part}" isn't a part in system.json`);
      continue;
    }
    if (i === 0) {
      if (s.via) errors.push(`${where}: the first stop is where the tour starts; it has no via`);
      continue;
    }
    const prev = sb.stops[i - 1].part;
    if (!parts.has(prev)) continue;
    if (prev === s.part) errors.push(`${where}: it stops on ${s.part} twice in a row; open the part with inside instead`);
    else if (!s.via) errors.push(`${where}: say how the tour gets here from ${prev}: an edge's label, or "${INSIDE}"`);
    else if (s.via === INSIDE) {
      const f = frameOf(s.part);
      if (!f || f !== frameOf(prev)) errors.push(`${where}: "${INSIDE}" moves within one frame of the map, and ${prev} and ${s.part} aren't in the same one`);
    } else if (!map.edges.some((e) => e.label === s.via && ((e.from === prev && e.to === s.part) || (e.from === s.part && e.to === prev)))) {
      const ways = map.edges.filter((e) => e.from === prev || e.to === prev).map((e) => `"${e.label}" (${e.from} → ${e.to})`);
      errors.push(`${where}: no edge "${s.via}" joins ${prev} and ${s.part} in system.json; ${prev}'s edges: ${ways.join(", ") || "none"}`);
    }
  }
  // The how lives in the moves: at least half the stops show it, each move with the beats it needs.
  const deep = sb.stops.filter((s) => moveOf(s)).length;
  if (deep * 2 < sb.stops.length) errors.push(`motion: ${deep} of ${sb.stops.length} stops have a move; at least half show how their part works`);
  for (const [i, s] of sb.stops.entries()) for (const e of moveErrors(s)) errors.push(`motion stop ${i + 1} (${s.part}) ${e}`);
  // A stop changes or decides something; one that only says where a thing sits folds into its neighbour's beat.
  for (const [i, s] of sb.stops.entries())
    if (!moveOf(s) && /\b(stores?|is stored|is kept|sits in|lives in|contains)\b/i.test(s.say) && !/\b(decides?|checks?|sends?|signs?|starts?|stops?|refuses?|swaps?|runs?|picks?|builds?|asks?|gives?|downloads?|installs?)\b/i.test(s.say))
      warnings.push(`motion stop ${i + 1} (${s.part}) only says where something sits; fold it into the stop before or after it as one beat ("…downloads it from the ${s.part}")`);
  const crossed = new Set(sb.stops.map((s) => s.part));
  if (crossed.size < 3) errors.push(`motion: the tour crosses ${crossed.size} parts; it shows how the system fits together, so it crosses at least 3`);

  // Today's changes are badges on the map, not the subject: that's the reels.
  const touched = new Map<Ref, string[]>([...gh.prs.map((p) => [refOf(p.repo, p.number, home), p.parts ?? []] as const), ...(gh.commits ?? []).map((c) => [commitRef(c.repo, c.sha, home), c.parts] as const)]);
  for (const [i, s] of sb.stops.entries())
    for (const r of s.today ?? []) {
      if (!prs.has(r)) errors.push(`motion stop ${i + 1} (${s.part}) marks ${refLabel(r)} new today, but it isn't in today's data.json`);
      else if (!(touched.get(r) ?? []).includes(s.part)) warnings.push(`motion stop ${i + 1} (${s.part}) marks ${refLabel(r)} new today, but its files are in ${(touched.get(r) ?? []).join(", ") || "no part"}`);
    }
  const news = sb.stops.filter((s) => s.today?.length).length;
  if (news * 2 > sb.stops.length) errors.push(`motion: ${news} of ${sb.stops.length} stops are today's changes; that walks through the news like the reels. Show how the area works and where it sits, and mark today's changes on the way`);
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const alike = (a: string, b: string) => {
    const x = words(a);
    const y = words(b);
    return [...x].filter((w) => y.has(w)).length / Math.max(1, Math.min(x.size, y.size));
  };
  const told = [...issue.stories.sections.map((s) => s.title), ...(issue.reels ? shortsOf(issue.reels).map((r) => r.headline) : [])];
  for (const t of told) if (alike(sb.title, t) >= 0.75) errors.push(`motion title "${sb.title}" retells today's "${t}"; the reels tell the news, the motion how the system works`);
  for (const r of o.recent ?? []) {
    const same = sb.stops.filter((s, i) => r.parts[i] === s.part).length;
    if (alike(sb.flow, r.flow) >= 0.75 || same * 10 >= sb.stops.length * 7) warnings.push(`motion repeats ${r.date}'s tour "${r.title}" (${r.flow}); take another flow`);
  }

  // Everything the motion may draw its words from, as one text.
  const brief = await readBrief(issue.root);
  const corpus = JSON.stringify([issue.data, issue.stories, issue.system, brief ?? null, issue.project.name]);
  const lower = corpus.toLowerCase();
  const numbers = new Set(corpus.match(/\d+(?:\.\d+)*/g) ?? []);
  const said = (where: string, text: string) => {
    for (const ref of mentions(text, home)) if (!known.has(ref)) errors.push(`motion ${where} mentions ${refLabel(ref)}, which data.json doesn't know`);
    // A number of two digits or more (a count, a size, a version) is a claim; a single digit is often just words.
    const bare = text.replace(/(?:^|[\s(])[\w.-]*#\d+\b/g, " ").replace(/\b[0-9a-f]{7,40}\b/g, " ");
    for (const n of bare.match(/\d+(?:\.\d+)*/g) ?? []) if ((n.length > 1 || n.includes(".")) && !numbers.has(n)) errors.push(`motion ${where} says ${n}, which is in none of the data, the digest, the system map or the brief`);
    // A name set as code, or one shaped like a path, a file or an identifier, must be the project's own.
    const names = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const w of text.replace(/`[^`]+`/g, " ").split(/\s+/)) {
      const t = w.replace(/^[("'“]+|[)"'”.,;:!?]+$/g, "");
      if (t.length > 3 && /[a-z][A-Z]|\w[_/]\w|\w\.\w|^--?\w|\w::\w|\(\)$/.test(t)) names.push(t);
    }
    for (const name of names) if (!lower.includes(name.toLowerCase())) errors.push(`motion ${where} names \`${name}\`, which is in none of the data, the digest, the system map or the brief`);
  };
  said("title", sb.title);
  said("dek", sb.dek);
  said("flow", sb.flow);
  said("question", sb.question);
  said("opening", sb.opening);
  said("closing", sb.closing);
  for (const [i, s] of sb.stops.entries()) {
    const where = `stop ${i + 1} (${s.part})`;
    said(where, s.say);
    // What a move shows is the project's own words: each word of four letters or more is somewhere in them.
    for (const [what, label] of moveWords(s)) {
      said(`${where} ${what}`, label);
      const strange = (label.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !lower.includes(w.slice(0, Math.max(4, w.length - 2))));
      if (strange.length) errors.push(`motion ${where} shows "${label}" as ${what}, but ${strange.map((w) => `"${w}"`).join(", ")} is in none of the brief, the system map or the data`);
    }
  }

  // Simplified Technical English, after ASD-STE100's writing rules: a sentence says one thing in at most 20 words,
  // the actor first, in the active voice; one word names one thing.
  const spokenText: [string, string][] = [
    ["question", sb.question],
    ["opening", sb.opening],
    ...sb.stops.flatMap((s, i): [string, string][] => [[`stop ${i + 1} (${s.part})`, s.say], ...(moveOf(s)?.beats ?? []).map((x, k): [string, string] => [`stop ${i + 1} (${s.part}) beat ${k + 1}`, x.say ?? ""])]),
    ["closing", sb.closing],
  ];
  // A word the brief defines, such as a "handle", is the project's own and never vague.
  const defined = new Set([...(brief?.terms ?? []).map((t) => t.term), ...(brief?.names ?? []).flatMap((n) => [n.name, ...(n.aka ?? [])])].map((w) => w.toLowerCase()));
  for (const [where, text] of spokenText)
    for (const sentence of text.split(/(?<=[.!?])\s+/).filter((x) => x.trim())) {
      const n = sentence.split(/\s+/).filter(Boolean).length;
      if (n > 20) errors.push(`motion ${where}: "${sentence}" has ${n} words; a sentence has at most 20 (one idea each)`);
      const passive = sentence.match(/\b(?:is|are|was|were|be|been|being|gets|get)\s+(?:\w+ly\s+)?(\w+ed|built|sent|made|given|taken|done|known|seen|shown|kept|held|run|written)\b/i);
      if (passive) warnings.push(`motion ${where}: "${passive[0]}" is passive; name the actor first ("The agent checks it", not "It is checked")`);
      const vague = sentence.match(/\b(handles?|takes care of|deals with|stuff|things|basically|magic)\b/i);
      if (vague && !defined.has(vague[0].toLowerCase()) && !defined.has(vague[0].toLowerCase().replace(/s$/, ""))) warnings.push(`motion ${where}: "${vague[0]}" is vague; say the action`);
    }
  // Written for the ear: a stop's actor is named once, then "it"; openings vary.
  const sentences = spokenText.flatMap(([where, text]) => text.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).map((x) => ({ where, x })));
  // A sentence's opening noun: its first word after an article. A pronoun is how to avoid repeating one.
  const opening = (x: string) => x.toLowerCase().replace(/^(the|a|an)\s+/, "").split(/[\s,]+/)[0];
  const pronoun = new Set(["it", "they", "this", "these", "its", "their"]);
  const names = issue.system.parts.map((p) => p.name.toLowerCase());
  // One warning a run, however long it goes on.
  const flagged = new Set<string>();
  const flag = (key: string, k: number, text: string) => {
    if (!flagged.has(`${key} ${k - 1}`)) warnings.push(text);
    flagged.add(`${key} ${k}`);
  };
  for (let k = 2; k < sentences.length; k++) {
    const three = sentences.slice(k - 2, k + 1);
    if (new Set(three.map((x) => opening(x.x))).size === 1 && !pronoun.has(opening(three[2].x))) flag(`open ${opening(three[2].x)}`, k, `motion ${three[0].where}: three sentences in a row start with "${opening(three[2].x)}"; name the actor once, then say "it", or start with first, then, if, once`);
    for (const n of names) if (three.every((x) => x.x.toLowerCase().includes(n))) flag(`name ${n}`, k, `motion ${three[0].where}: "${n}" is named in three sentences in a row; after the first, say "it"`);
  }
  if (brief) {
    const words = [...spokenText.map(([, t]) => t), ...sb.stops.flatMap((s) => moveWords(s).map(([, w]) => w))].join(" \n ");
    const forms = brief.names.flatMap((n) => [n.name, ...(n.aka ?? [])].filter((f) => !/[/:@]/.test(f)).map((f) => ({ f, of: n.name })));
    // Longest first, each found once, so "device agent" isn't also counted as "agent".
    let rest = ` ${words} `;
    const used = new Map<string, Set<string>>();
    for (const { f, of } of [...forms].sort((a, b) => b.f.length - a.f.length)) {
      const re = new RegExp(`(^|[^\\w-])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi");
      if (!re.test(rest)) continue;
      rest = rest.replace(re, "$1 ");
      used.set(of, new Set([...(used.get(of) ?? []), f.toLowerCase()]));
      const owners = new Set(forms.filter((x) => x.f.toLowerCase() === f.toLowerCase()).map((x) => x.of));
      if (owners.size > 1) warnings.push(`motion says "${f}", which the brief uses for ${[...owners].join(" and ")}; name each one by its own name`);
    }
    for (const [name, set] of used) if (set.size > 1) warnings.push(`motion calls ${name} ${[...set].map((x) => `"${x}"`).join(" and ")}; one word for one thing: say "${name}" each time`);
  }
  return { errors, warnings };
}

// What a stop's move needs, besides what the schema says.
function moveErrors(s: Stop): string[] {
  const m = moveOf(s);
  if (!m) return [];
  const b = m.beats;
  const out: string[] = [];
  // How many beats each move takes, and what every beat of it must give.
  const rules: Record<Move, { n: [number, number]; what: string; keys: ("label" | "other" | "count")[] }> = {
    steps: { n: [3, 5], what: "steps", keys: ["label"] },
    fanout: { n: [2, 4], what: "waves", keys: ["label", "count"] },
    cycle: { n: [3, 5], what: "beats round the loop", keys: ["label"] },
    layers: { n: [2, 4], what: "rings", keys: ["label"] },
    compare: { n: [2, 4], what: "rows", keys: ["label", "other"] },
    gate: { n: [2, 4], what: "beats", keys: ["label"] },
    free: { n: [2, 6], what: "sentences", keys: [] },
  };
  const r = rules[m.move];
  if (b.length < r.n[0] || b.length > r.n[1]) out.push(`has a ${m.move} of ${b.length} beats; a ${m.move} has ${r.n[0]}–${r.n[1]} ${r.what}`);
  for (const key of r.keys) if (b.some((x) => x[key] === undefined)) out.push(`has a ${m.move} beat without its ${key}`);
  if (m.move === "fanout" && !s.source) out.push("has a fanout without its source: who sends");
  if (m.move === "compare" && !s.sides) out.push("has a compare without its two sides' titles");
  if (m.move === "layers") {
    const rings = b.map((x) => x.ring);
    if (rings.some((r) => r === undefined)) out.push("has a layers beat without its ring: 1 is the outermost");
    else if ([...rings].sort().join() !== b.map((_, k) => k + 1).join()) out.push(`numbers its rings ${rings.join(", ")}; they are 1 to ${b.length}, 1 the outermost, each once`);
  }
  if (m.move === "gate") {
    if (!s.check) out.push("has a gate without its check");
    if (!b.some((x) => x.tone === "bad") || !b.some((x) => x.tone === "good")) out.push("has a gate that doesn't show both ways: a beat refused (bad) and a beat let through (good)");
  }
  if (m.move === "free") {
    const f = s.free;
    if (!f) return [...out, "picks free but gives no free composition"];
    const ids = new Set([...f.nodes.map((x) => x.id), ...(f.links ?? []).map((x) => x.id), ...(f.copies ?? []).map((x) => x.id), ...(f.texts ?? []).map((x) => x.id)]);
    const nodes = new Set(f.nodes.map((x) => x.id));
    const links = new Set((f.links ?? []).map((x) => x.id));
    for (const l of f.links ?? []) for (const end of [l.from, l.to]) if (!nodes.has(end)) out.push(`links to "${end}", which is no node of its free composition`);
    for (const c of f.copies ?? []) if (!nodes.has(c.of)) out.push(`copies "${c.of}", which is no node`);
    for (const t of f.tokens ?? []) if (!links.has(t.along)) out.push(`runs a token along "${t.along}", which is no link`);
    for (const e of f.effects ?? []) if (!ids.has(e.target)) out.push(`puts ${e.effect} on "${e.target}", which isn't in its composition`);
    const slots = [...f.nodes, ...(f.texts ?? [])].map((x) => x.at.join(","));
    for (const dup of new Set(slots.filter((x, k) => slots.indexOf(x) !== k))) out.push(`puts two things in slot [${dup}]; one slot holds one`);
    const beats = [...f.nodes, ...(f.links ?? []), ...(f.copies ?? []), ...(f.tokens ?? []), ...(f.texts ?? []), ...(f.effects ?? [])].map((x) => x.beat ?? 0);
    if (beats.some((k) => k >= b.length)) out.push(`brings something in on beat ${Math.max(...beats)}, but it has ${b.length} sentences`);
    const elements = f.nodes.length + (f.links ?? []).length + (f.copies ?? []).reduce((n, c) => n + c.n, 0) + (f.tokens ?? []).length + (f.texts ?? []).length + (f.effects ?? []).length;
    if (elements > 40) out.push(`composes ${elements} elements; a free beat has at most 40`);
  }
  return out;
}

// Every word a stop's move shows, with where.
function moveWords(s: Stop): [string, string][] {
  const m = moveOf(s);
  const out: [string, string][] = [];
  for (const [k, x] of (m?.beats ?? []).entries()) for (const [what, w] of [["label", x.label], ["failure", x.fail], ["second side", x.other]] as const) if (w) out.push([`beat ${k + 1}'s ${what}`, w]);
  if (s.source) out.push(["source", s.source]);
  if (s.check) out.push(["check", s.check]);
  for (const [k, side] of (s.sides ?? []).entries()) out.push([`side ${k + 1}`, side]);
  for (const n of s.free?.nodes ?? []) if (n.label) out.push([`node ${n.id}`, n.label]);
  for (const l of s.free?.links ?? []) if (l.label) out.push([`link ${l.id}`, l.label]);
  for (const t of s.free?.texts ?? []) out.push([`text ${t.id}`, t.text]);
  return out;
}

if (import.meta.main) {
  const { root, date, values } = await issueArgs({ look: { type: "boolean", default: false } });
  const issue = await loadIssue(root, date);
  const { errors, warnings } = await check(issue);
  // --look also measures the reels in a browser: text on text or outside the frame fails the issue.
  if (values.look && !errors.length) {
    const { look } = await import("./look");
    for (const f of (await look(issue)).findings) (f.level === "error" ? errors : warnings).push(`reel ${f.reel}: ${f.detail}`);
  }
  for (const w of warnings) console.warn(`warn  ${w}`);
  for (const e of errors) console.error(`error ${e}`);
  console.log(errors.length ? `check failed: ${errors.length} errors` : `check passed (${warnings.length} warnings)`);
  process.exit(errors.length ? 1 : 0);
}
