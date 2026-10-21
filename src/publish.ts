import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { S3Client } from "bun";
import { issueArgs, issueDates, loadIssue, need } from "./issue";
import { indexOf } from "./render";

// Publish makes R2 match the data root: every issue's JSON and page, the editions list and the shared assets.
// Pages are rendered again on each publish, so a template or player fix reaches every issue of its format.
// Only what changed is uploaded. --announce DATE posts that issue to Slack.
const { root, out, values } = await issueArgs({ "dry-run": { type: "boolean", default: false }, announce: { type: "string" } });
const dry = values["dry-run"] as boolean;
const issues = await Promise.all((await issueDates(root)).map((d) => loadIssue(root, d)));
const { id, name } = issues[0].project;

const s3 = new S3Client({
  endpoint: need("R2_ENDPOINT"),
  bucket: need("R2_BUCKET"),
  accessKeyId: need("R2_ACCESS_KEY_ID"),
  secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
});

// What R2 holds now, from one listing per thousand keys. A single-part upload's ETag is its MD5, sometimes marked weak: W/"<md5>".
const held = new Map<string, string>();
for (const prefix of ["static/", `${id}/`]) {
  let token: string | undefined;
  do {
    const page = await s3.list({ prefix, continuationToken: token });
    for (const o of page.contents ?? []) held.set(o.key, (o.eTag ?? "").replace(/^W\//, "").replaceAll('"', ""));
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
}

const files: [key: string, body: Uint8Array | string][] = [];
for (const f of await readdir(join(out, "static"))) files.push([`static/${f}`, await Bun.file(join(out, "static", f)).bytes()]);
for (const issue of issues) {
  const date = issue.data.date;
  const pageDir = join(out, id, date);
  if (!(await Bun.file(join(pageDir, "index.html")).exists())) throw new Error(`${join(pageDir, "index.html")} is missing; run render --all first`);
  // The page and what render put beside it: the motion's video and poster, named by their content.
  for (const f of await readdir(pageDir)) files.push([`${id}/issues/${date}/${f}`, await Bun.file(join(pageDir, f)).bytes()]);
  for (const f of ["data.json", "stories.json", "reels.json", ...(issue.motion ? ["motion.json"] : [])]) files.push([`${id}/issues/${date}/${f}`, await Bun.file(join(issue.dir, f)).bytes()]);
}
files.push([`${id}/index.json`, JSON.stringify(indexOf(issues), null, 1)]);

const md5 = (body: string | Uint8Array) => new Bun.CryptoHasher("md5").update(body).digest("hex");
const changed = files.filter(([key, body]) => held.get(key) !== md5(body));
for (const [key] of changed) console.log(`${dry ? "would put" : "put"} ${key}`);
// The content type comes from the key's extension.
if (!dry) for (let i = 0; i < changed.length; i += 8) await Promise.all(changed.slice(i, i + 8).map(([key, body]) => s3.write(key, body, { type: Bun.file(key).type })));
console.log(`${issues.length} issues, ${changed.length} ${dry ? "files to upload" : "files uploaded"}`);

const readJson = async <T>(key: string, empty: T): Promise<T> => ((await s3.exists(key)) ? ((await s3.file(key).json()) as T) : empty);

type Listed = { id: string; name: string };
const projects = await readJson<Listed[]>("projects.json", []);
if (!projects.some((p) => p.id === id && p.name === name)) {
  const list = [...projects.filter((p) => p.id !== id), { id, name }].sort((a, b) => a.name.localeCompare(b.name));
  console.log(`${dry ? "would update" : "update"} projects.json (${list.length} projects)`);
  if (!dry) await s3.write("projects.json", JSON.stringify(list, null, 1), { type: "application/json" });
}

const announce = values.announce as string | undefined;
const webhook = process.env.SLACK_WEBHOOK_URL;
const site = process.env.SITE_URL;
if (announce && webhook && site) {
  const issue = issues.find((i) => i.data.date === announce);
  if (!issue) throw new Error(`no issue ${announce} to announce`);
  const label = issue.data.edition === "thursday" ? "Thursday edition" : "The Daily Token";
  const text = `🗞️ *${label} · ${name} · ${announce}*\n${issue.stories.headline}\n<${site.replace(/\/$/, "")}/${id}/${announce}/|Watch the reels and read the digest>`;
  console.log(`${dry ? "would post" : "post"} to Slack`);
  if (!dry) {
    const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`Slack answered ${res.status}: ${await res.text()}`);
  }
}
