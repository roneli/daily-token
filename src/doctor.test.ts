import { expect, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor";
import { ENGINE } from "./issue";

test("doctor names what's missing and how to fix it", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-"));
  expect((await doctor(root))[0].detail).toContain("daily-token init");

  await cp(join(ENGINE, "fixtures", "sample"), root, { recursive: true });
  const token = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    const found = await doctor(root, { S3_BUCKET: "b" });
    const by = Object.fromEntries(found.map((f) => [f.what, f]));
    expect(by["project.json"].ok).toBe(true);
    expect(by["system.json"].ok).toBe(true);
    expect(by["source github"].detail).toContain("GH_TOKEN is not set");
    expect(by["publishing (S3)"].detail).toContain("S3_ENDPOINT");
  } finally {
    if (token) process.env.GH_TOKEN = token;
  }
});
