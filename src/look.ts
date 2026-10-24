import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser } from "./browser";
import { ENGINE, type Issue, issueArgs, loadIssue } from "./issue";
import { renderIssue } from "./render";

// look: the issue in a real browser. It measures every reel at rest (text on text, text outside the frame,
// text across a line) and saves a picture of each, for the Readers. A reel's markup is complete at rest,
// so the pictures show every element; text that a cue swaps shows its last value.

export type Finding = { reel: string; level: "error" | "warn"; detail: string };

// Runs in the page: the reel's own SVG moves into a bare host. Moving it, not copying it, keeps its marker ids
// unique and its arrowheads drawn. Its cues and animations are settled, so text, bars, states and the token show
// how the reel ends; every element shows at rest. unmount puts it back.
function mount(id: string) {
  const svg = document.querySelector(`#reel-${id} svg.scene`) as SVGSVGElement;
  const cues = [...svg.querySelectorAll<SVGElement>("[data-cue]")].sort((a, b) => Number(a.dataset.at ?? 0) - Number(b.dataset.at ?? 0));
  for (const c of cues) {
    const el = svg.querySelector(`#${CSS.escape(c.dataset.el ?? "")}`);
    if (!el) continue;
    if (c.dataset.cue === "text") el.textContent = c.dataset.to ?? "";
    if (c.dataset.cue === "class") {
      el.classList.remove("on", "bad-on", "good-on");
      if (c.dataset.to) el.classList.add(c.dataset.to);
    }
    if (c.dataset.cue === "move") {
      el.setAttribute("cx", c.dataset.x ?? "");
      el.setAttribute("cy", c.dataset.y ?? "");
    }
  }
  for (const el of svg.querySelectorAll<SVGElement>("[data-anim]")) {
    const { anim, to, prefix, suffix } = el.dataset;
    if (anim === "text" || anim === "type") el.textContent = to ?? "";
    if (anim === "width") el.setAttribute("width", to ?? "");
    if (anim === "count") el.textContent = `${prefix ?? ""}${Number(to).toLocaleString("en-US")}${suffix ?? ""}`;
  }
  const mark = document.createElement("i");
  mark.id = "look-mark";
  svg.replaceWith(mark);
  const host = document.createElement("div");
  host.id = "look-host";
  host.style.cssText = "position:fixed;left:0;top:0;width:640px;height:360px;z-index:9999;background:var(--bg)";
  host.append(svg);
  document.body.append(host);
}

function unmount() {
  const host = document.getElementById("look-host") as HTMLElement;
  (document.getElementById("look-mark") as HTMLElement).replaceWith(host.firstChild as Node);
  host.remove();
}

// Runs in the page, on the mounted reel. A template marks a line that passes behind text by design data-look="behind".
function measure({ reel, scene }: { reel: string; scene: boolean }) {
  const svg = document.querySelector("#look-host svg") as SVGSVGElement;
  const out: { reel: string; level: "error" | "warn"; detail: string }[] = [];
  const short = (t: Element) => `"${(t.textContent ?? "").trim().slice(0, 40)}"`;
  const texts = [...svg.querySelectorAll("text")].filter((t) => t.textContent?.trim()).map((t) => ({ t, b: t.getBBox() }));
  const strokes = [...svg.querySelectorAll("line, path, polyline")].filter((e) => {
    const cs = getComputedStyle(e);
    return cs.stroke !== "none" && Number.parseFloat(cs.strokeWidth) > 0 && e.getAttribute("data-look") !== "behind";
  }) as SVGGeometryElement[];
  const inside = (b: DOMRect, x: number, y: number) => x > b.x + 1 && x < b.x + b.width - 1 && y > b.y + 2 && y < b.y + b.height - 2;
  for (const [i, { t, b }] of texts.entries()) {
    for (const { t: o, b: c } of texts.slice(i + 1))
      if (b.x < c.x + c.width - 1 && c.x < b.x + b.width - 1 && b.y < c.y + c.height - 2 && c.y < b.y + b.height - 2) out.push({ reel, level: "error", detail: `text ${short(t)} overlaps text ${short(o)}` });
    if (b.x < 0 || b.x + b.width > 640 || b.y < 0 || b.y + b.height > 360) out.push({ reel, level: "error", detail: `text ${short(t)} runs outside the 640×360 frame` });
    for (const s of strokes) {
      const len = s.getTotalLength();
      for (let d = 0; d <= len; d += 2) {
        const p = s.getPointAtLength(d);
        if (inside(b, p.x, p.y)) {
          out.push({ reel, level: "warn", detail: `text ${short(t)} crosses a ${s.tagName}` });
          break;
        }
      }
    }
  }
  // A drawn scene's line that stops just short of a box reads as a slip: it should touch the box or keep clear of it.
  if (scene) {
    const boxes = [...svg.querySelectorAll("rect")].map((r) => r.getBBox());
    const gap = (b: DOMRect, x: number, y: number) => Math.hypot(Math.max(b.x - x, 0, x - b.x - b.width), Math.max(b.y - y, 0, y - b.y - b.height));
    for (const s of strokes) {
      const len = s.getTotalLength();
      for (const end of [s.getPointAtLength(0), s.getPointAtLength(len)]) {
        const near = Math.min(...boxes.map((b) => gap(b, end.x, end.y)));
        if (near > 3 && near < 24) out.push({ reel, level: "error", detail: `a ${s.tagName} ends ${Math.round(near)}px short of a box at (${Math.round(end.x)}, ${Math.round(end.y)}); end it on the box's edge` });
      }
    }
  }
  return out;
}

export async function look(issue: Issue, opts: { shots?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "daily-look-"));
  const file = (f: string) => `file://${join(ENGINE, "static", f)}`;
  // Without the player: it rewinds every reel to its start, which hides all that animates in.
  const { html, reels } = await renderIssue(issue, { css: file("daily.css"), js: "data:text/javascript,", bpCss: file("blueprint.css"), bpJs: "data:text/javascript," });
  await Bun.write(join(dir, "index.html"), html);
  if (opts.shots) await mkdir(opts.shots, { recursive: true });

  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`file://${join(dir, "index.html")}`);
    await page.evaluate(() => document.fonts.ready);
    const findings: Finding[] = [];
    const shots: { reel: string; path: string }[] = [];
    for (const r of reels) {
      await page.evaluate(mount, r.id);
      findings.push(...((await page.evaluate(measure, { reel: r.id, scene: r.template === "scene" })) as Finding[]));
      if (opts.shots) {
        const path = join(opts.shots, `${r.id}.png`);
        await page.locator("#look-host").screenshot({ path });
        shots.push({ reel: r.id, path });
      }
      await page.evaluate(unmount);
    }
    return { findings, shots };
  } finally {
    await b.close();
  }
}

if (import.meta.main) {
  const { root, date, values } = await issueArgs({ shots: { type: "string" } });
  const { findings, shots } = await look(await loadIssue(root, date), { shots: values.shots as string | undefined });
  for (const f of findings) console[f.level === "error" ? "error" : "warn"](`${f.level === "error" ? "error" : "warn "} reel ${f.reel}: ${f.detail}`);
  if (shots.length) console.log(`${shots.length} pictures in ${values.shots}`);
  const errors = findings.filter((f) => f.level === "error").length;
  console.log(errors ? `look failed: ${errors} errors` : `look passed (${findings.length} warnings)`);
  process.exit(errors ? 1 : 0);
}
