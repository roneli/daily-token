import { rest } from "./collect";

// A repo's files at HEAD, read through the REST API with GH_TOKEN.
export async function repoTree(repo: string): Promise<string[]> {
  const { tree } = await rest<{ tree: { path: string; type: string }[] }>(`repos/${repo}/git/trees/HEAD?recursive=1`);
  return tree.filter((e) => e.type === "blob").map((e) => e.path);
}

export async function repoFile(repo: string, path: string): Promise<string | undefined> {
  const r = await rest<{ content?: string; encoding?: string }>(`repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
  return r.content && r.encoding === "base64" ? Buffer.from(r.content, "base64").toString("utf8") : undefined;
}
