// Positions and timing for the before-after reel. The template only places what this returns.

const CW = 10.2; // advance of the 17px mono face on the value lines
const TEXT_X = 92;
const CHIP = 62;
const CHIP_GAP = 10;

export function layout(raw: Record<string, unknown>) {
  const prefix = raw.prefix as string;
  const before = raw.before as string;
  const chips = (raw.chips as { text: string }[]) ?? [];
  const notes = (raw.notes as string[]) ?? [];

  const strike = { x1: TEXT_X + prefix.length * CW, x2: TEXT_X + (prefix.length + before.length) * CW, y: 119, at: 1000 };
  const after = { at: 1600, typeAt: 1800, typeMs: 1500 };
  const x0 = 320 - (chips.length * (CHIP + CHIP_GAP) - CHIP_GAP) / 2;
  const laidChips = chips.map((c, i) => ({ ...c, x: x0 + i * (CHIP + CHIP_GAP), cx: x0 + i * (CHIP + CHIP_GAP) + CHIP / 2, at: 3600 + i * 180 }));
  let t = 3600 + chips.length * 180 + 600;
  const laidNotes = notes.map((text, k) => ({ text, y: 290 + k * 30, at: t + k * 600 }));
  t += notes.length * 600;

  return {
    fields: { call: raw.call, prefix, before, after: raw.after, suffix: raw.suffix, textX: TEXT_X, strike, afterAt: after, chips: laidChips, notes: laidNotes },
    ms: Math.round(t + 900),
  };
}
