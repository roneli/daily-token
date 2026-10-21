import { expect, test } from "bun:test";
import { configured } from ".";

const project = { id: "p", name: "P" };

test("a project's sources come with their config", () => {
  const [g] = configured({ ...project, sources: { github: { repos: ["acme/rocket", "acme/ground"] } } });
  expect(g.source.name).toBe("github");
  expect(g.config).toEqual({ repos: ["acme/rocket", "acme/ground"] });
});

test("a project from before sources reads its repos as GitHub's", () => {
  expect(configured({ ...project, repos: ["acme/rocket"] })[0].config).toEqual({ repos: ["acme/rocket"] });
});

test("a bad config, an unknown source and no source at all are refused", () => {
  expect(() => configured({ ...project, sources: { github: { repos: ["not a repo"] } } })).toThrow("sources.github/repos/0");
  expect(() => configured({ ...project, sources: { github: {} } })).toThrow("repos");
  expect(() => configured({ ...project, sources: { linear: {} } })).toThrow("no such source");
  expect(() => configured(project)).toThrow("no sources");
});
