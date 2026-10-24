import { type Browser, chromium } from "playwright-core";

// Playwright's Chromium when installed, else Chrome (CI sets LOOK_BROWSER=chrome). LOOK_BROWSER picks one explicitly.
// Its own module, importing nothing of ours: render films and draws with it while it is still loading.
export async function browser(): Promise<Browser> {
  const want = process.env.LOOK_BROWSER;
  if (want === "chrome") return chromium.launch({ channel: "chrome" });
  if (want === "chromium") return chromium.launch();
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: "chrome" });
  }
}
