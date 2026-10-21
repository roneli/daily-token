// Lines and timing for the title reel: the title wrapped in large type, then the dek below it.

const TITLE = { size: 30, advance: 15, width: 540, lead: 38 };
const DEK = { size: 18, advance: 8.6, width: 540, lead: 26 };

export function wrap(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > chars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}

export function layout(raw: Record<string, unknown>) {
  const title = wrap(raw.title as string, Math.floor(TITLE.width / TITLE.advance));
  const dek = wrap((raw.dek as string) ?? "", Math.floor(DEK.width / DEK.advance));
  const height = title.length * TITLE.lead + (dek.length ? 24 + dek.length * DEK.lead : 0);
  let y = Math.round(180 - height / 2 + TITLE.size);
  const titleLines = title.map((text, i) => ({ text, y: y + i * TITLE.lead, at: 200 + i * 250 }));
  y += (title.length - 1) * TITLE.lead + 24 + DEK.lead;
  const t = 200 + title.length * 250 + 500;
  const dekLines = dek.map((text, i) => ({ text, y: y + i * DEK.lead, at: t + i * 300 }));
  return { fields: { title: titleLines, dek: dekLines, barY: titleLines[0].y - TITLE.size - 18 }, ms: Math.max(6000, t + dek.length * 300 + 4000) };
}
