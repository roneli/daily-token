// A change's diff for the agents: its changed lines file by file, code before tests and docs, generated files and
// lockfiles left out, cut to a budget so one large change doesn't crowd out the day's others.

export type FilePatch = { filename: string; patch?: string };

const GENERATED = /(^|\/)(node_modules|vendor|dist|build|gen|generated|__snapshots__)\/|\.lock$|lock\.(json|ya?ml)$|\.min\.|\.(png|jpe?g|gif|svg|ico|pdf|woff2?|ttf)$/i;
const ASIDE = /[._-](test|spec)\.|(^|\/)(tests?|__tests__)\//i;
const DOC = /\.mdx?$/i;
const PER_FILE = 1_500;
// The day's diffs together, and the least and most one change gets of them.
const DAY = 60_000;
const LEAST = 600;
const MOST = 4_000;

export const diffBudget = (changes: number) => Math.max(LEAST, Math.min(MOST, Math.floor(DAY / Math.max(1, changes))));

export function diffOf(files: FilePatch[], max: number): string {
  const rank = (f: string) => (ASIDE.test(f) ? 1 : 0) + (DOC.test(f) ? 2 : 0);
  const kept = files.filter((f) => f.patch && !GENERATED.test(f.filename)).sort((a, b) => rank(a.filename) - rank(b.filename));
  let out = "";
  for (const f of kept) {
    const room = Math.min(PER_FILE, max - out.length - f.filename.length - 8);
    if (room < 200) break;
    const patch = f.patch as string;
    out += `--- ${f.filename}\n${patch.length > room ? `${patch.slice(0, room)}\n…` : patch}\n`;
  }
  return out.trimEnd();
}
