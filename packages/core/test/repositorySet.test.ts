import { describe, expect, it } from "vitest";
import {
  assertRepositorySetCanCreateProject,
  parseRepositorySetYaml
} from "../src/repositorySet.js";

describe("repository sets", () => {
  it("uses mapping keys as project-scoped aliases without deriving names from URLs", () => {
    const set = parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  root:
    url: https://example.test/team/source
    root: true
    ref: main
    protect: [main]
  api:
    url: git@example.test:odd/path-without-dot-git
`);
    expect(set).toEqual({
      schemaVersion: 1,
      repositories: {
        root: {
          url: "https://example.test/team/source",
          root: true,
          rootRef: "refs/heads/main",
          protectedPatterns: ["main"]
        },
        api: {
          url: "git@example.test:odd/path-without-dot-git",
          root: false,
          protectedPatterns: []
        }
      }
    });
    expect(() => assertRepositorySetCanCreateProject(set)).not.toThrow();
  });

  it("rejects duplicate keys, unknown fields, and ambiguous project roots", () => {
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  api: {url: one}
  api: {url: two}
`)).toThrow(/unique|map keys/i);
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  api: {url: one, provider: github}
`)).toThrow(/unknown field 'provider'/);
    const withoutRoot = parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  api: {url: one}
`);
    expect(() => assertRepositorySetCanCreateProject(withoutRoot)).toThrow(/exactly one/);
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  api: {url: "https://token@example.test/api"}
`)).toThrow(/must not contain credentials/);
  });
});
