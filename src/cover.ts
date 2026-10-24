import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { Liquid } from "liquidjs";
import type { Browser, Page } from "playwright-core";
import { ENGINE, githubOf, type Issue } from "./issue";
import { browser } from "./look";
import { fontFaces, MOTION_TAB } from "./motion";
import { TABS } from "./render";
import { signInPath } from "./signin";

// The share cover: a still picture of an issue for link previews (1200×630), and preview.html, what the issue's
// address shows without a sign-in: the preview tags, and the same card with a way to sign in. Anyone with the link sees the
// cover, so by default it shows nothing of the work: the nameplate, the company and its logo, the issue's number,
// day and edition, and counts. project.json's cover.headline adds the headline.

const WIDTH = 1200;
const HEIGHT = 630;
const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// One headless page for every cover of a render, opened only when a cover is drawn.
export function shooter() {
  let open: Promise<{ b: Browser; page: Page }> | undefined;
  const shoot = async (html: string) => {
    open ??= browser().then(async (b) => ({ b, page: await b.newPage({ viewport: { width: WIDTH, height: HEIGHT } }) }));
    const { page } = await open;
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    return page.screenshot({ type: "png" });
  };
  shoot.close = async () => (await open)?.b.close();
  return shoot;
}
export type Shooter = ReturnType<typeof shooter>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function coverFiles(issue: Issue, rings: string[], dir: string, shoot: Shooter, css: string) {
  const { project, data, stories } = issue;
  const gh = githubOf(data);
  const weekly = data.edition === "weekly";
  const at = new Date(`${data.date}T12:00:00Z`);
  const part = (o: Intl.DateTimeFormatOptions) => at.toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
  const day = `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}`;
  const no = String(data.issue).padStart(3, "0");
  const company = project.company ?? project.name;
  const changes = gh.prs.length + (gh.commits?.length ?? 0);
  const told = issue.reels.threads.length;
  const counts = weekly ? `${plural(told, "story", "stories")} · ${plural(gh.week?.totals.prs ?? changes, "PR")} this week` : `${plural(told, "story", "stories")} · ${plural(changes, "change")}`;
  const headline = project.cover?.headline ? stories.headline : "";

  let logo = "";
  if (project.cover?.logo) {
    const file = Bun.file(join(issue.root, project.cover.logo));
    if (!(await file.exists())) throw new Error(`project.json cover.logo: ${project.cover.logo} isn't in the data root`);
    const type = TYPES[extname(project.cover.logo).toLowerCase()];
    if (!type) throw new Error(`project.json cover.logo: ${project.cover.logo} isn't SVG, PNG, GIF or WebP`);
    logo = `data:${type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
  }

  const liquid = new Liquid({ root: [join(ENGINE, "templates")], extname: ".liquid", outputEscape: "escape" });
  // What the cover and the preview page both show. Liquid counts an empty string as true: none is null.
  const card = { company, logo: logo || null, no, day, weekly, headline: headline || null, counts, rings: rings.slice(0, 8) };
  const html = await liquid.renderFile("cover", {
    fonts: (await fontFaces()).css,
    // The site's light tokens only: its rules are for the page, and a preview is drawn light.
    css: (await Bun.file(join(ENGINE, "static", "daily.css")).text()).match(/:root\s*\{[^}]*\}/)?.[0] ?? "",
    ...card,
    tabs: [...TABS.map((t) => t.name), ...(issue.motion ? [MOTION_TAB] : [])].join(" · "),
  });
  // Named by what it shows, so an unchanged cover isn't drawn again; an older one goes.
  const image = `cover.${createHash("sha256").update(html).digest("hex").slice(0, 10)}.png`;
  if (!(await Bun.file(join(dir, image)).exists())) await Bun.write(join(dir, image), await shoot(html));
  for (const f of await readdir(dir)) if (/^cover\.[0-9a-f]{10}\.png$/.test(f) && f !== image) await rm(join(dir, f));

  const site = process.env.SITE_URL?.replace(/\/$/, "");
  const issueAt = `/${project.id}/${data.date}/`;
  const title = `The Daily Token · ${company} · No. ${no}${weekly ? " · Weekly edition" : ""}`;
  await Bun.write(
    join(dir, "preview.html"),
    await liquid.renderFile("preview", {
      ...card,
      css,
      title,
      description: headline || `${day} · ${counts}`,
      url: site ? `${site}${issueAt}` : null,
      image: site ? `${site}${issueAt}${image}` : image,
      signin: signInPath(issueAt),
    }),
  );
  return { image };
}
