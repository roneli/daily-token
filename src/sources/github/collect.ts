import { join } from "node:path";
import { daysBefore, iso, weekdayOf, window } from "../../time";
import { type Commit, commitRef, type Data, type DataV1, type GithubDay, githubOf, type IssueEvent, issueDates, need, type OpenPR, type PR, type Project, type Ref, readJson, refOf, type System, type Week } from "../../issue";

// One day of a project's GitHub repos: merged PRs, direct commits, issues, tags, open PRs. No judgment, no model.
// The repos come from project.json's sources.github and the parts from system.json; everything else is GitHub's.

const API = "https://api.github.com/graphql";
const EPIC_DEPTH = 6;
const OPEN_PRS = 50;

// allowMissing: a reference to a number GitHub doesn't have comes back null instead of failing the run.
async function gql<T>(query: string, variables: Record<string, unknown>, allowMissing = false): Promise<T> {
  const res = await fetch(API, { method: "POST", headers: { authorization: `bearer ${need("GH_TOKEN")}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = (await res.json()) as { data?: T; errors?: { type?: string; message: string }[] };
  const errors = (body.errors ?? []).filter((e) => !(allowMissing && e.type === "NOT_FOUND"));
  for (const e of body.errors ?? []) if (!errors.includes(e)) console.warn(`skip: ${e.message}`);
  if (!res.ok || errors.length) throw new Error(`GitHub ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? res.statusText}`);
  return body.data as T;
}

export async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, { headers: { authorization: `bearer ${need("GH_TOKEN")}`, accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

export function coauthors(messages: string[], author: string): string[] {
  const names = new Set<string>();
  for (const m of messages) for (const t of m.matchAll(/^co-authored-by:\s*(.+?)\s*<[^>]*>\s*$/gim)) if (t[1] !== author) names.add(t[1]);
  return [...names];
}

export const partOf = (body: string) => [...body.matchAll(/\bpart of #(\d+)\b/gi)].map((m) => +m[1]);

// GitHub closes these when a commit carrying them lands on the default branch.
export const closingRefs = (message: string) => [...message.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)].map((m) => +m[1]);

// Globs match home-repo paths as written; another repo's paths as "name:path".
export function partsOf(files: string[], system: System, prefix = "") {
  const globs = system.parts.map((p) => ({ id: p.id, core: p.core === true, globs: (p.paths ?? []).map((g) => new Bun.Glob(g)) }));
  const ignore = (system.ignore ?? []).map((g) => new Bun.Glob(g));
  const parts = new Set<string>();
  const unmatched: string[] = [];
  let core = false;
  for (const file of files) {
    const f = prefix + file;
    const hit = globs.filter((p) => p.globs.some((g) => g.match(f)));
    for (const p of hit) parts.add(p.id);
    if (hit.some((p) => p.core)) core = true;
    if (!hit.length && !ignore.some((g) => g.match(f))) unmatched.push(f);
  }
  return { parts: [...parts], core, unmatched };
}

type Chain = { number: number; title: string; repository: { nameWithOwner: string }; parent: Chain | null; subIssuesSummary: { total: number; completed: number } };

// Root first, ending with `n` itself when `self` is set: [epic, …, parent]. A parent may live in another repo.
export function epicPath(n: number, chains: Map<number, Chain>, self: boolean, home: string): Ref[] {
  const path: Ref[] = [];
  for (let c = chains.get(n) ?? null, first = true; c; c = c.parent, first = false) if (self || !first) path.unshift(refOf(c.repository.nameWithOwner, c.number, home));
  return path;
}

const PR_FIELDS = `number title url mergedAt additions deletions body
  author { login ... on User { name } }
  files(first: 100) { nodes { path } pageInfo { hasNextPage endCursor } }
  closingIssuesReferences(first: 20) { nodes { number } }
  commits(first: 100) { nodes { commit { message } } }`;

type RawPR = {
  number: number; title: string; url: string; mergedAt: string; additions: number; deletions: number; body: string;
  author: { login: string; name?: string | null } | null;
  files: { nodes: { path: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  closingIssuesReferences: { nodes: { number: number }[] };
  commits: { nodes: { commit: { message: string } }[] };
};

async function mergedPrs(owner: string, name: string, base: string, from: string, to: string): Promise<RawPR[]> {
  const q = `repo:${owner}/${name} is:pr is:merged base:${base} merged:${from}..${to}`;
  const out: RawPR[] = [];
  for (let after: string | null = null; ; ) {
    const r: { search: { nodes: RawPR[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(
      `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 25, after: $after) { nodes { ... on PullRequest { ${PR_FIELDS} } } pageInfo { hasNextPage endCursor } } }`,
      { q, after },
    );
    out.push(...r.search.nodes);
    if (!r.search.pageInfo.hasNextPage) break;
    after = r.search.pageInfo.endCursor;
  }
  for (const pr of out) {
    for (let page = pr.files.pageInfo; page.hasNextPage; ) {
      const r: { repository: { pullRequest: { files: RawPR["files"] } } } = await gql(
        `query($o: String!, $n: String!, $pr: Int!, $after: String) { repository(owner: $o, name: $n) { pullRequest(number: $pr) { files(first: 100, after: $after) { nodes { path } pageInfo { hasNextPage endCursor } } } } }`,
        { o: owner, n: name, pr: pr.number, after: page.endCursor },
      );
      pr.files.nodes.push(...r.repository.pullRequest.files.nodes);
      page = r.repository.pullRequest.files.pageInfo;
    }
  }
  const [a, b] = [Date.parse(from), Date.parse(to)];
  return out.filter((p) => Date.parse(p.mergedAt) >= a && Date.parse(p.mergedAt) < b).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

async function chains(owner: string, name: string, numbers: number[]): Promise<Map<number, Chain>> {
  const map = new Map<number, Chain>();
  if (!numbers.length) return map;
  let fields = "number title repository { nameWithOwner } subIssuesSummary { total completed }";
  for (let i = 0; i < EPIC_DEPTH; i++) fields = `number title repository { nameWithOwner } subIssuesSummary { total completed } parent { ${fields} }`;
  // A reference may be a PR; only issues have parents.
  const aliases = numbers.map((n) => `i${n}: issueOrPullRequest(number: ${n}) { ... on Issue { ${fields} } }`).join("\n");
  const r = await gql<{ repository: Record<string, Chain | null> }>(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${aliases} } }`, { o: owner, n: name }, true);
  for (const n of numbers) {
    const c = r.repository[`i${n}`];
    if (c?.number) map.set(n, c);
  }
  return map;
}

type RawOpen = {
  number: number; title: string; url: string; isDraft: boolean; createdAt: string; updatedAt: string; additions: number; deletions: number; body: string;
  reviewDecision: OpenPR["review"]; author: RawPR["author"];
  files: { nodes: { path: string }[] }; closingIssuesReferences: { nodes: { number: number }[] };
};

// Parts come from the first 100 files; an open PR is a preview, not a record.
async function openPrs(owner: string, name: string) {
  const r = await gql<{ repository: { pullRequests: { totalCount: number; nodes: RawOpen[] } } }>(
    `query($o: String!, $n: String!) { repository(owner: $o, name: $n) { pullRequests(states: OPEN, first: ${OPEN_PRS}, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes {
      number title url isDraft createdAt updatedAt additions deletions body reviewDecision
      author { login ... on User { name } }
      files(first: 100) { nodes { path } }
      closingIssuesReferences(first: 20) { nodes { number } }
    } } } }`,
    { o: owner, n: name },
  );
  return r.repository.pullRequests;
}

type RawCommit = {
  oid: string; url: string; committedDate: string; message: string; messageHeadline: string; additions: number; deletions: number;
  author: { name: string | null; user: { login: string; name: string | null } | null } | null;
  associatedPullRequests: { nodes: { merged: boolean }[] };
};

// Commits on the default branch in the window that no merged PR carries: work pushed straight to it.
async function directCommits(owner: string, name: string, branch: string, from: string, to: string) {
  const out: (RawCommit & { files: string[] })[] = [];
  for (let after: string | null = null; ; ) {
    const r: { repository: { ref: { target: { history: { nodes: RawCommit[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } } } } = await gql(
      `query($o: String!, $n: String!, $ref: String!, $from: GitTimestamp!, $to: GitTimestamp!, $after: String) { repository(owner: $o, name: $n) { ref(qualifiedName: $ref) { target { ... on Commit {
        history(since: $from, until: $to, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
          oid url committedDate message messageHeadline additions deletions
          author { name user { login name } }
          associatedPullRequests(first: 5) { nodes { merged } }
        } }
      } } } } }`,
      { o: owner, n: name, ref: `refs/heads/${branch}`, from, to, after },
    );
    const h = r.repository.ref.target.history;
    for (const c of h.nodes) {
      if (c.associatedPullRequests.nodes.some((p) => p.merged)) continue;
      const files = (await rest<{ files?: { filename: string }[] }>(`repos/${owner}/${name}/commits/${c.oid}`)).files ?? [];
      out.push({ ...c, files: files.map((f) => f.filename) });
    }
    if (!h.pageInfo.hasNextPage) break;
    after = h.pageInfo.endCursor;
  }
  const [a, b] = [Date.parse(from), Date.parse(to)];
  return out.filter((c) => Date.parse(c.committedDate) >= a && Date.parse(c.committedDate) < b);
}

type RawIssue = {
  number: number; title: string; url: string; createdAt: string; closedAt: string | null; stateReason: IssueEvent["reason"]; body: string;
  author: RawPR["author"]; labels: { nodes: { name: string }[] }; subIssuesSummary: { total: number; completed: number };
  timelineItems: { nodes: { closer: { __typename: string; number?: number; oid?: string; repository?: { nameWithOwner: string } } | null }[] };
};

// Issues opened or closed in the window, with what closed them.
async function issueEvents(owner: string, name: string, from: string, to: string) {
  const found = new Map<number, RawIssue>();
  for (const q of [`repo:${owner}/${name} is:issue created:${from}..${to}`, `repo:${owner}/${name} is:issue closed:${from}..${to}`]) {
    for (let after: string | null = null; ; ) {
      const r: { search: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(
        `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on Issue {
          number title url createdAt closedAt stateReason body
          author { login ... on User { name } }
          labels(first: 10) { nodes { name } }
          subIssuesSummary { total completed }
          timelineItems(last: 1, itemTypes: CLOSED_EVENT) { nodes { ... on ClosedEvent { closer { __typename ... on PullRequest { number repository { nameWithOwner } } ... on Commit { oid repository { nameWithOwner } } } } } }
        } } } }`,
        { q, after },
      );
      for (const i of r.search.nodes) found.set(i.number, i);
      if (!r.search.pageInfo.hasNextPage) break;
      after = r.search.pageInfo.endCursor;
    }
  }
  return [...found.values()];
}

type Tag = { name: string; target: { oid: string; committedDate?: string; tagger?: { date: string }; target?: { oid: string } } };

async function repoState(owner: string, name: string) {
  return gql<{ repository: { defaultBranchRef: { name: string }; refs: { nodes: Tag[] } } }>(
    `query($o: String!, $n: String!) { repository(owner: $o, name: $n) {
      defaultBranchRef { name }
      refs(refPrefix: "refs/tags/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name target { oid ... on Commit { committedDate } ... on Tag { tagger { date } target { oid } } } } }
    } }`,
    { o: owner, n: name },
  );
}

// The week ending on a Thursday: that day plus the archived issues since Friday.
// `refetched` marks a day collected again after the fact: its epic counts are today's, so it can't be a starting point.
export function weekOf(date: string, earlier: { date: string; headline: string; data: GithubDay; refetched?: boolean }[], today: GithubDay, home: string): Week {
  const from = daysBefore(date, 6);
  const days = [...earlier.filter((d) => d.date >= from && d.date < date), { date, headline: "", data: today }].sort((a, b) => a.date.localeCompare(b.date));
  const epicKey = (path: Ref[]) => String(path[0] ?? "none");
  const count = (d: GithubDay) => {
    const epics: Record<string, number> = {};
    for (const p of [...d.prs, ...(d.commits ?? [])]) epics[epicKey(p.epicPath)] = (epics[epicKey(p.epicPath)] ?? 0) + 1;
    return epics;
  };
  const first = new Map<Ref, number>();
  for (const d of days) if (!d.refetched && d.data !== today) for (const e of d.data.epics) if (!first.has(refOf(e.repo, e.number, home))) first.set(refOf(e.repo, e.number, home), e.closed);
  return {
    from,
    to: date,
    days: days.map((d) => ({ date: d.date, headline: d.headline, prs: d.data.prs.length, commits: d.data.commits?.length ?? 0, epics: count(d.data) })),
    totals: {
      prs: days.reduce((n, d) => n + d.data.prs.length, 0),
      commits: days.reduce((n, d) => n + (d.data.commits?.length ?? 0), 0),
      issuesClosed: days.reduce((n, d) => n + (d.data.issues?.filter((i) => i.closed).length ?? 0), 0),
      tags: days.reduce((n, d) => n + d.data.tags.length, 0),
    },
    // An epic's first count this week came from the earliest issue that showed it; only today's count is new.
    epics: today.epics.map((e) => {
      const ref = refOf(e.repo, e.number, home);
      const start = first.get(ref);
      return { ref, title: e.title, closed: e.closed, total: e.total, closedThisWeek: start === undefined ? null : e.closed - start };
    }),
  };
}

async function collectRepo(repo: string, home: string, system: System, win: { from: string; to: string }) {
  const [owner, name] = repo.split("/");
  const prefix = repo === home ? "" : `${name}:`;
  const state = await repoState(owner, name);
  const branch = state.repository.defaultBranchRef.name;
  const raw = await mergedPrs(owner, name, branch, win.from, win.to);
  const pushed = await directCommits(owner, name, branch, win.from, win.to);
  const open = await openPrs(owner, name);
  const rawIssues = await issueEvents(owner, name, win.from, win.to);

  const refsOf = (closes: number[], body: string) => ({ closes, partOf: partOf(body) });
  const refs = [
    ...raw.map((p) => refsOf(p.closingIssuesReferences.nodes.map((n) => n.number), p.body ?? "")),
    ...pushed.map((c) => refsOf(closingRefs(c.message), c.message)),
    ...open.nodes.map((o) => refsOf(o.closingIssuesReferences.nodes.map((n) => n.number), o.body ?? "")),
  ];
  const graph = await chains(owner, name, [...new Set([...refs.flatMap((r) => [...r.closes, ...r.partOf]), ...rawIssues.map((i) => i.number)])]);
  const pathOf = (closes: number[], within: number[]) =>
    [...closes.map((n) => epicPath(n, graph, false, home)), ...within.map((n) => epicPath(n, graph, true, home))].sort((a, b) => b.length - a.length)[0] ?? [];
  const nameOf = (a: RawPR["author"]) => a?.name || a?.login || "ghost";
  const within = (t: string) => Date.parse(t) >= Date.parse(win.from) && Date.parse(t) < Date.parse(win.to);

  const unmatched: string[] = [];
  const placed = (files: string[]) => {
    const r = partsOf(files, system, prefix);
    unmatched.push(...r.unmatched);
    return r;
  };

  const prs: PR[] = raw.map((p) => {
    const files = p.files.nodes.map((f) => f.path);
    const { parts, core } = placed(files);
    const closes = p.closingIssuesReferences.nodes.map((n) => n.number);
    const author = nameOf(p.author);
    return {
      repo, number: p.number, title: p.title, url: p.url, mergedAt: p.mergedAt, additions: p.additions, deletions: p.deletions,
      files, parts, closes, epicPath: pathOf(closes, partOf(p.body ?? "")), core, author,
      coauthors: coauthors(p.commits.nodes.map((c) => c.commit.message), author),
      body: p.body ?? "",
    };
  });

  const commits: Commit[] = pushed.map((c) => {
    const { parts, core } = placed(c.files);
    const closes = closingRefs(c.message);
    const author = c.author?.user?.name || c.author?.name || c.author?.user?.login || "ghost";
    return {
      repo, sha: c.oid, title: c.messageHeadline, url: c.url, at: iso(c.committedDate), additions: c.additions, deletions: c.deletions,
      files: c.files, parts, closes, epicPath: pathOf(closes, partOf(c.message)), core, author,
      coauthors: coauthors([c.message], author),
      body: c.message.slice(c.messageHeadline.length).trim(),
    };
  });

  const openPrList: OpenPR[] = open.nodes.map((o) => {
    const closes = o.closingIssuesReferences.nodes.map((n) => n.number);
    return {
      repo, number: o.number, title: o.title, url: o.url, draft: o.isDraft, review: o.reviewDecision, author: nameOf(o.author),
      createdAt: o.createdAt, updatedAt: o.updatedAt, additions: o.additions, deletions: o.deletions,
      parts: partsOf(o.files.nodes.map((f) => f.path), system, prefix).parts, closes, epicPath: pathOf(closes, partOf(o.body ?? "")),
      isNew: within(o.createdAt), active: within(o.updatedAt), body: o.body ?? "",
    };
  });

  const issueList: IssueEvent[] = rawIssues
    .map((i) => {
      const closed = i.closedAt !== null && within(i.closedAt);
      const closer = closed ? i.timelineItems.nodes[0]?.closer : null;
      const closedBy = closer?.number ? refOf(closer.repository?.nameWithOwner, closer.number, home) : closer?.oid ? commitRef(closer.repository?.nameWithOwner, closer.oid, home) : null;
      return {
        repo, number: i.number, title: i.title, url: i.url, opened: within(i.createdAt), closed,
        reason: closed ? i.stateReason : null, closedBy, author: nameOf(i.author), labels: i.labels.nodes.map((l) => l.name),
        epicPath: epicPath(i.number, graph, false, home), subIssues: i.subIssuesSummary, body: i.body ?? "",
      };
    })
    .sort((a, b) => a.number - b.number);

  const issues = new Map<Ref, Chain>();
  for (let c of graph.values()) for (; c; c = c.parent as Chain) issues.set(refOf(c.repository.nameWithOwner, c.number, home), c);
  const epics = [...new Set([...prs, ...commits, ...openPrList].flatMap((p) => p.epicPath ?? []))]
    .map((r) => issues.get(r) as Chain)
    .filter((c) => c.subIssuesSummary.total > 0)
    .map((c) => ({ repo: c.repository.nameWithOwner, number: c.number, title: c.title, closed: c.subIssuesSummary.completed, total: c.subIssuesSummary.total }));

  const tags = state.repository.refs.nodes
    .map((t) => ({ repo, name: t.name, at: iso(t.target.tagger?.date ?? t.target.committedDate ?? 0), sha: (t.target.target?.oid ?? t.target.oid).slice(0, 8) }))
    .filter((t) => within(t.at));

  return { prs, commits, issues: issueList, tags, epics, open: openPrList, openCount: open.totalCount, unmatched };
}

export type CollectOpts = { root: string; date: string; cutoff: string; tz: string; project: Project; system: System; repos: string[] };

// withWeek: off when collecting a past day only to count it in Thursday's week.
export async function collect(opts: CollectOpts, withWeek = true): Promise<GithubDay & { unmatched: string[] }> {
  const { project, system, repos } = opts;
  const home = repos[0];
  const win = window(opts.date, opts.cutoff, opts.tz, project.days);
  const each = await Promise.all(repos.map((repo) => collectRepo(repo, home, system, win)));

  const epics = new Map(each.flatMap((r) => r.epics).map((e) => [refOf(e.repo, e.number, home), e]));
  const earlier = (await issueDates(opts.root)).filter((d) => d < opts.date);
  const data: GithubDay & { unmatched: string[] } = {
    repo: home,
    repos,
    prs: each.flatMap((r) => r.prs).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)),
    commits: each.flatMap((r) => r.commits).sort((a, b) => a.at.localeCompare(b.at)),
    issues: each.flatMap((r) => r.issues),
    tags: each.flatMap((r) => r.tags).sort((a, b) => a.at.localeCompare(b.at)),
    epics: [...epics.values()],
    openPrs: each.flatMap((r) => r.open).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    openPrCount: each.reduce((n, r) => n + r.openCount, 0),
    unmatched: [...new Set(each.flatMap((r) => r.unmatched))].sort(),
  };
  if (weekdayOf(opts.date) === "thu" && withWeek) {
    const archived = [];
    for (let n = 6; n >= 1; n--) {
      const d = daysBefore(opts.date, n);
      if (project.days?.length && !project.days.includes(weekdayOf(d))) continue;
      const dir = join(opts.root, "issues", d);
      const stories = join(dir, "stories.json");
      const file = join(dir, "data.json");
      // A day the archive lacks is collected again from GitHub: the week counts it, but it has no headline.
      const past = earlier.includes(d) && (await Bun.file(file).exists()) ? githubOf(await readJson<Data | DataV1>(file)) : await collect({ ...opts, date: d }, false);
      archived.push({ date: d, headline: (await Bun.file(stories).exists()) ? (await readJson<{ headline: string }>(stories)).headline : "", data: past, refetched: !earlier.includes(d) });
      console.log(`[collect] week: ${d} ${earlier.includes(d) ? "from the archive" : "collected"} (${past.prs.length} PRs)`);
    }
    data.week = weekOf(opts.date, archived, data, home);
  }
  return data;
}
