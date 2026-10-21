import type { Source } from "../harness/plugin";
import { errorsOf } from "../harness/schema";
import type { Project } from "../issue";
import { github } from "./github";

// Every source the engine knows. A project turns one on by configuring it in project.json "sources".
export const SOURCES: Source[] = [github as Source];

// The project's sources with their config, checked. A project from before sources lists GitHub repos as "repos".
export function configured(project: Project): { source: Source; config: unknown }[] {
  const config: Record<string, unknown> = project.sources ?? (project.repos ? { github: { repos: project.repos } } : {});
  const out = [];
  for (const [name, c] of Object.entries(config)) {
    const source = SOURCES.find((s) => s.name === name);
    if (!source) throw new Error(`project.json sources.${name}: no such source; the engine has ${SOURCES.map((s) => s.name).join(", ")}`);
    const errors = errorsOf(source.config, c, `sources.${name}`);
    if (errors.length) throw new Error(`project.json ${errors.join("; ")}`);
    out.push({ source, config: c });
  }
  if (!out.length) throw new Error("project.json configures no sources");
  return out;
}
