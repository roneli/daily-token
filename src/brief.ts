import { join } from "node:path";
import { errorsOf, load } from "./harness/schema";
import { readJson } from "./issue";

// brief.json, in the data root: what the project is and what its words mean. Optional; agents write plainer with it.
export type Brief = {
  about: string;
  names: { name: string; is: string; aka?: string[] }[];
  terms: { term: string; plain: string }[];
  from?: string[];
};

export async function readBrief(root: string): Promise<Brief | undefined> {
  const file = join(root, "brief.json");
  if (!(await Bun.file(file).exists())) return undefined;
  const brief = await readJson<Brief>(file);
  const errors = errorsOf(await load("brief"), brief, "brief");
  if (errors.length) throw new Error(`brief.json: ${errors.join("; ")}`);
  return brief;
}
