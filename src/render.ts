import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Liquid } from "liquidjs";
import { type Commit, commitRef, ENGINE, FORMAT, type GithubDay, githubOf, type Issue, issueArgs, issueDates, loadIssue, type PR, type Ref, refLabel, refOf, repoName, reposOf, shortsOf, writeJson } from "./issue";
import { estimated, linesOf, lookOf, MOTION_TAB, type MotionFiles, motionFiles, refsOf, startsOf, timeline } from "./motion";
import { kokoro, voiceOf } from "./voice";

export const TYPES: Record<string, [label: string, color: string]> = {
  feature: ["New", "--accent"],
  fix: ["Fix", "--good"],
  security: ["Security", "--bad"],
  testing: ["Testing", "--s1"],
  better: ["Better", "--s3"],
  cleanup: ["Cleanup", "--s0"],
  rename: ["Rename", "--s0"],
};

// Categorical slots in fixed order; "other" is always the neutral.
const SLOTS = ["--s1", "--s2", "--s3", "--s4"];

// Text fields are plain text with three marks: `code`, **bold** and #123 or name#123 (a PR or issue link).
export function inline(s: string, repos: string[]): string {
  const byName = new Map(repos.map((r) => [repoName(r), r]));
  return Bun.escapeHTML(s)
    .replace(/`([^`]+)`/g, '<span class="mono">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])([\w.-]+)?#(\d+)\b/g, (all, pre: string, name: string | undefined, n: string) => {
      const repo = name ? byName.get(name) : repos[0];
      return repo ? `${pre}<a href="${issueUrl(repo, Number(n))}" target="_blank">${name ?? ""}#${n}</a>` : all;
    });
}

const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
const pullUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

type Layout = (fields: Record<string, unknown>) => { fields: Record<string, unknown>; ms: number };

async function layoutFor(template: string): Promise<Layout | null> {
  const path = join(ENGINE, "templates", "reels", `${template}.layout.ts`);
  if (!(await Bun.file(path).exists())) return null;
  return (await import(path)).layout as Layout;
}

type SectionView = { id: string; story: string; color: string; cards: { ref: Ref; parts: { id: string }[]; typeLabel: string; typeColor: string; headline: string; url: string }[] };

const HOUR = 36e5;
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The Blueprint: which parts the day's cards touched, in whose color, and the release strip.
function blueprintView(issue: Issue, sections: SectionView[]) {
  const { system, stories } = issue;
  const gh = githubOf(issue.data);
  const parts = system.parts.map((p) => {
    const cards = sections.flatMap((s) => s.cards.filter((c) => c.parts.some((x) => x.id === p.id)).map((c) => ({ ...c, section: s })));
    const bySection = new Map<string, number>();
    for (const c of cards) bySection.set(c.section.id, (bySection.get(c.section.id) ?? 0) + 1);
    const top = [...bySection].sort((a, b) => b[1] - a[1])[0]?.[0];
    const home = sections.find((s) => s.id === top);
    const [x, y, w, h] = p.box;
    const showSub = Boolean(p.sub) && h > 34;
    return {
      ...p, x, y, w, h, showSub,
      nameY: y + (showSub ? h / 2 - 2 : h / 2 + 4),
      subY: y + h / 2 + 13,
      n: cards.length,
      lit: cards.length > 0,
      color: home?.color ?? "--s0",
      story: home ? titleCase(home.story) : "",
      sectionId: home?.id ?? "",
      today: stories.parts?.[p.id] ?? "",
      cards: cards.map((c) => ({ ref: c.ref, url: c.url, typeLabel: c.typeLabel, typeColor: c.typeColor, headline: c.headline })),
    };
  });
  const lit = parts.filter((p) => p.lit);
  const start = [...lit].sort((a, b) => b.n - a.n)[0]?.id ?? "";
  const legend = sections.filter((s) => lit.some((p) => p.sectionId === s.id)).map((s) => ({ name: titleCase(s.story), color: s.color }));

  let tags = null;
  if (gh.tags.length) {
    const times = gh.tags.map((t) => Date.parse(t.at));
    const a = Math.floor(Math.min(...times) / HOUR) * HOUR - HOUR / 2;
    const b = Math.ceil(Math.max(...times) / HOUR) * HOUR;
    const step = b - a > 12 * HOUR ? 3 * HOUR : HOUR;
    const x = (t: number) => 20 + ((t - a) / (b - a)) * 520;
    const ticks = [];
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) ticks.push({ x: x(t), label: hhmm(t) });
    const prefixes = [...new Set(gh.tags.map((t) => t.name.split("/")[0]))];
    tags = {
      ticks,
      marks: gh.tags.map((t, i) => {
        const tx = x(Date.parse(t.at));
        const row = i % 3;
        return { ...t, url: `https://github.com/${t.repo ?? reposOf(issue.project)[0]}/commit/${t.sha}`, x: tx, labelY: 14 + row * 18, top: 16 + row * 18, end: tx > 380, color: SLOTS[prefixes.indexOf(t.name.split("/")[0]) % SLOTS.length] };
      }),
    };
  }
  return { size: system.size, groups: system.groups, edges: system.edges, parts, lit, start, legend, tags };
}

// The recap's small chart: one bar per day of the week, merged PRs plus direct commits.
function weekView(gh: GithubDay, date: string) {
  if (!gh.week) return null;
  const max = Math.max(1, ...gh.week.days.map((d) => d.prs + d.commits));
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric" });
  return {
    ...gh.week,
    range: `${day(gh.week.from)} – ${day(gh.week.to)}`,
    bars: gh.week.days.map((d) => ({ label: day(d.date), n: d.prs + d.commits, pct: Math.round(((d.prs + d.commits) / max) * 100), date: d.date, today: d.date === date })),
  };
}

const who = (p: PR | Commit) => `${p.author} · ${p.coauthors.length ? p.coauthors.join(" + ") : "solo"}`;

// The issue's tabs, in order, and the line a phone's section menu says about each: the one place they are named.
export const TABS = [
  { id: "reels", name: "Digest", line: "Watch today's changes as short stories" },
  { id: "digest", name: "Ledger", line: "Read what changed, one card at a time" },
  { id: "blueprint", name: "Blueprint", line: "See where today's changes landed" },
];
const MOTION_LINE = "Hear how one part works, start to finish";

export async function renderIssue(issue: Issue, assets: Record<string, string>, files?: MotionFiles) {
  const { data, stories, reels, system } = issue;
  const gh = githubOf(data);
  const engine = new Liquid({ root: [join(ENGINE, "templates")], extname: ".liquid", outputEscape: "escape", strictFilters: true, timezoneOffset: 0 });
  const { project } = issue;
  const home = reposOf(project)[0];
  engine.registerFilter("inline", (s: string) => inline(s ?? "", reposOf(project)));
  engine.registerFilter("ref", (r: Ref) => refLabel(r));
  engine.registerFilter("num", (n: number) => n.toLocaleString("en-US"));

  // Everything a card or reel can cite: merged PRs and direct commits.
  const pr = new Map<Ref, PR | Commit>([...gh.prs.map((p) => [refOf(p.repo, p.number, home), p] as const), ...(gh.commits ?? []).map((c) => [commitRef(c.repo, c.sha, home), c] as const)]);
  const part = new Map(system.parts.map((p) => [p.id, p]));
  const color = new Map<string, string>();
  let slot = 0;
  for (const s of stories.sections) color.set(s.id, s.story === "other" ? "--s0" : SLOTS[slot++ % SLOTS.length]);

  const sections = stories.sections.map((s) => ({
    ...s,
    color: color.get(s.id) ?? "--s0",
    cards: s.cards.map((c) => {
      const p = pr.get(c.ref);
      if (!p) throw new Error(`stories: section ${s.id} cites ${refLabel(c.ref)}, which is not in data.json`);
      const [label, typeColor] = TYPES[c.type] ?? [c.type, "--s0"];
      return {
        ...c,
        lead: s.lead?.ref === c.ref ? s.lead : null,
        typeLabel: label,
        typeColor,
        url: p.url,
        core: p.core,
        who: who(p),
        also: (c.with ?? []).map((w) => ({ ref: w, url: pr.get(w)?.url ?? "" })),
        parts: c.parts.map((id) => ({ id, name: part.get(id)?.name ?? id })),
      };
    }),
  }));

  const openPrs = gh.openPrs.map((o) => ({ ...o, ref: refOf(o.repo, o.number, home), url: o.url ?? pullUrl(o.repo ?? home, o.number) }));
  const openUrl = new Map<Ref, string>(openPrs.map((o) => [o.ref, o.url]));
  const reelViews: (ReturnType<typeof shortsOf>[number] & { color: string; svg: string; chips: { n: Ref; url: string; core: boolean }[] })[] = [];
  for (const r of shortsOf(reels)) {
    const layout = await layoutFor(r.template);
    const laid = layout ? layout(r.fields) : { fields: r.fields, ms: r.ms };
    const reelColor = color.get(r.thread) ?? (r.thread === "recap" ? "--accent" : "--s0");
    const svg = await engine.renderFile(`reels/${r.template}`, { f: laid.fields, reel: r, color: reelColor });
    reelViews.push({
      ...r,
      ms: Math.max(r.ms, laid.ms),
      color: reelColor,
      svg,
      chips: r.refs.map((n) => ({ n, url: pr.get(n)?.url ?? openUrl.get(n) ?? "", core: pr.get(n)?.core ?? false })),
    });
  }

  // The player's threads: a story's carries its section, for the sheet under its shorts.
  const threads = reels.threads.map((t, i) => {
    const section = sections.find((s) => s.id === t.id);
    const shorts = reelViews.filter((r) => r.thread === t.id);
    const title = section?.title ?? (t.id === "recap" ? (stories.recap?.title ?? "This week") : "What's coming");
    return { id: t.id, name: t.name, title, index: i, color: shorts[0]?.color ?? "--s0", section: section ?? null, shorts };
  });

  // The day at a glance, above the stories: how much merged, and the story that took most of it.
  const merged = new Set(gh.prs.map((p) => refOf(p.repo, p.number, home)));
  const told = threads.filter((t) => t.section).map((t) => ({ name: t.name, prs: new Set(t.section?.cards.flatMap((c) => [c.ref, ...(c.with ?? [])]).filter((r) => merged.has(r))).size }));
  const top = told.reduce<(typeof told)[number] | undefined>((a, t) => (t.prs > (a?.prs ?? 0) ? t : a), undefined);
  const overview = [
    `${gh.prs.length} PR${gh.prs.length === 1 ? "" : "s"} merged, told in ${told.length} ${told.length === 1 ? "story" : "stories"}`,
    top && told.length > 1 && top.prs * 2 > gh.prs.length ? `; ${top.prs} of them are “${top.name}”.` : ".",
    // Phones hide this line under the reels, so it speaks to a wide screen, touch or not.
    " Tap or click the card for the next short, beside it for the next story.",
  ].join("");

  const byWho = new Map<string, number>();
  for (const p of [...gh.prs, ...(gh.commits ?? [])]) byWho.set(who(p), (byWho.get(who(p)) ?? 0) + 1);

  const motion = motionView(issue, pr, files);
  const html = await engine.renderFile("issue", {
    data,
    github: gh,
    project: { ...project, repos: reposOf(project) },
    epics: gh.epics.map((e) => ({ ...e, ref: refOf(e.repo, e.number, home), url: issueUrl(e.repo ?? home, e.number) })),
    openPrs,
    stories,
    week: weekView(gh, data.date),
    recapThread: reels.threads.some((t) => t.id === "recap"),
    sections,
    threads,
    overview,
    rail: stories.rail,
    bp: blueprintView(issue, sections),
    who: [...byWho].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n })),
    assets,
    total: { prs: gh.prs.length, commits: gh.commits?.length ?? 0 },
    motion,
    tabs: [...TABS, ...(motion ? [{ id: "motion", name: MOTION_TAB, line: MOTION_LINE }] : [])],
    // Each tab's name by its id, for the words that point at a tab.
    names: Object.fromEntries(TABS.map((t) => [t.id, t.name])),
  });
  return { html, reels: reelViews };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// The Cutaway tab: the video when it has been rendered, and its narration to read, each line at its time.
function motionView(issue: Issue, cited: Map<Ref, PR | Commit>, files?: MotionFiles) {
  const m = issue.motion;
  if (!m) return null;
  const home = reposOf(issue.project)[0];
  const repos = new Map(reposOf(issue.project).map((r) => [repoName(r), r]));
  // A ref from an earlier issue isn't in today's data; its link follows from its shape.
  const urlOf = (r: Ref) => {
    const known = cited.get(r)?.url;
    if (known) return known;
    if (typeof r === "number") return pullUrl(home, r);
    const [, name, sep, id] = r.match(/^([\w.-]+)?([#@])?(\w+)$/) ?? [];
    const repo = (name && repos.get(name)) || home;
    return sep === "#" ? pullUrl(repo, Number(id)) : `https://github.com/${repo}/commit/${id ?? r}`;
  };
  // Before the video is made, each line is timed by its length.
  const guess = files ? undefined : timeline(m, estimated(m).seconds);
  const starts = files?.starts ?? (guess ? startsOf(guess) : []);
  const seconds = files?.seconds ?? guess?.seconds ?? 0;
  const lines = linesOf(m).map((text, i) => ({ start: Math.floor(starts[i] * 10) / 10, at: clock(starts[i]), text }));
  const parts = new Map(issue.system.parts.map((p) => [p.id, p.name]));
  return {
    label: MOTION_TAB,
    title: m.title,
    dek: m.dek,
    flow: m.flow,
    seconds,
    length: clock(seconds),
    parts: [...new Set(m.stops.map((s) => parts.get(s.part) ?? s.part))],
    video: files?.video ?? null,
    poster: files?.poster ?? null,
    lines,
    chips: refsOf(m).map((n) => ({ n, url: urlOf(n), core: cited.get(n)?.core ?? false })),
  };
}

export const indexOf = (issues: Issue[]) =>
  issues.map((i) => ({ date: i.data.date, edition: i.data.edition, headline: i.stories.headline })).sort((a, b) => b.date.localeCompare(a.date));

async function pinAssets(outRoot: string) {
  await mkdir(join(outRoot, "static"), { recursive: true });
  const pinned: Record<string, string> = {};
  for (const [key, file] of [["css", "static/daily.css"], ["js", "static/player.js"], ["bpCss", "static/blueprint.css"], ["bpJs", "static/blueprint.js"]]) {
    const body = await Bun.file(join(ENGINE, file)).text();
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 10);
    const [name, ext] = basename(file).split(".");
    const out = `static/${name}.${hash}.${ext}`;
    await Bun.write(join(outRoot, out), body);
    pinned[key] = `../../${out}`;
  }
  return pinned;
}

// An issue of an older format renders with the engine of that format: the version its data.json names, installed
// once from npm beside this one; or, in a git checkout of the engine, the commit tagged format-v<N>.
async function olderEngine(format: number, version?: string) {
  const run = (cmd: string[], cwd = ENGINE) => {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
  };
  let render: string;
  if (version) {
    const dir = join(tmpdir(), `daily-token-engine-${version}`);
    render = join(dir, "node_modules", "daily-token", "src", "render.ts");
    if (!existsSync(render)) {
      console.log(`format ${format}: installing daily-token@${version} in ${dir}`);
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "package.json"), "{}\n");
      run(["bun", "add", "--exact", `daily-token@${version}`], dir);
    }
  } else {
    const tag = `format-v${format}`;
    if (!existsSync(join(ENGINE, ".git"))) throw new Error(`issues of format ${format} name no engine version, and this engine isn't a git checkout to find ${tag} in; convert them with \`daily-token migrate\``);
    const dir = join(tmpdir(), `daily-token-${tag}`);
    render = join(dir, "src", "render.ts");
    if (!(await Bun.file(join(dir, "package.json")).exists())) {
      console.log(`format ${format}: checking out ${tag} in ${dir}`);
      run(["git", "worktree", "add", "--force", "--detach", dir, tag]);
      run(["bun", "install", "--frozen-lockfile"], dir);
    }
  }
  return (root: string, dates: string[], out: string) => run(["bun", render, "--root", resolve(root), "--dates", dates.join(","), "--out", resolve(out)], dirname(dirname(render)));
}

if (import.meta.main) {
  // --dates a,b,c renders several issues in one process: an older engine gets all of its format at once.
  const { root, date, out, values } = await issueArgs({ all: { type: "boolean", default: false }, dates: { type: "string" } });
  const all = await issueDates(root);
  const dates = new Set(values.all ? all : values.dates ? (values.dates as string).split(",") : [date]);
  const issues = await Promise.all(all.map((d) => loadIssue(root, d)));
  const formatOf = (i: Issue) => i.data.format ?? 1;
  const byFormat = new Map<number, Issue[]>();
  for (const i of issues) if (dates.has(i.data.date)) byFormat.set(formatOf(i), [...(byFormat.get(formatOf(i)) ?? []), i]);

  // Older formats first: their engines write an index of their own, and the one below replaces it.
  for (const [f, group] of [...byFormat].filter(([f]) => f !== FORMAT).sort(([a], [b]) => a - b)) {
    if (f > FORMAT) throw new Error(`an issue has format ${f}; this engine knows up to ${FORMAT}`);
    // One engine renders the whole format: the newest version any of its issues names.
    const versions = group.map((i) => i.data.engine).filter((v): v is string => Boolean(v));
    const version = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    (await olderEngine(f, version))(root, group.map((i) => i.data.date), out);
  }

  const assets = await pinAssets(out);
  for (const issue of byFormat.get(FORMAT) ?? []) {
    const dir = join(out, issue.project.id, issue.data.date);
    // The motion's files are named by everything that changes them, so only a new storyboard, look or voice renders
    // again; an issue without one keeps none.
    const props = issue.motion && { storyboard: issue.motion, system: issue.system, look: lookOf(issue.project.name, issue.data.date), voice: voiceOf(issue.project.pipeline?.motion) };
    const { html } = await renderIssue(issue, assets, await motionFiles(props, dir, kokoro));
    const path = join(dir, "index.html");
    await Bun.write(path, html);
    console.log(`rendered ${path}`);
  }
  // The same shape publish keeps in R2, so the editions list works in preview too. It lists every issue in the root,
  // not only the ones rendered now.
  const project = issues[0].project.id;
  await writeJson(join(out, project, "index.json"), indexOf(issues));
}
