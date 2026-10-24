// The largest type, up to `most`, at which every text fits its width, and no smaller than `least`: short labels
// read on a phone (a reel is about half size there, so 18 here is about 9 px), long ones still fit a wide screen.
// `least` is the size a template had before it fit its type, so no reel reads smaller than it did.
// Widths are estimates, per character: IBM Plex Mono 0.6 em, Plex Sans semibold about 0.58 em.

export const MONO = 0.6;
export const SANS = 0.58;

export function fit(texts: string[], width: number, most: number, least: number, em = MONO): number {
  const longest = Math.max(1, ...texts.map((t) => t.length));
  return Math.max(least, Math.min(most, Math.floor((width / (longest * em)) * 2) / 2));
}
