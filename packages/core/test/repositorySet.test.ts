import { describe, expect, it } from "vitest";
import {
  assertRepositorySetCanCreateProject,
  mapExternalRefToRepository,
  mapRepositoryRefToExternal,
  resolveRepositoryConnection,
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
      upstreams: {},
      repositories: {
        root: {
          url: "https://example.test/team/source",
          fallback: false,
          root: true,
          rootRef: "refs/heads/main",
          protectedPatterns: ["main"]
        },
        api: {
          url: "git@example.test:odd/path-without-dot-git",
          fallback: false,
          root: false,
          protectedPatterns: []
        }
      }
    });
    expect(() => assertRepositorySetCanCreateProject(set)).not.toThrow();
  });

  it("maps multiple managed repositories onto disjoint namespaces in one upstream", () => {
    const set = parseRepositorySetYaml(`
schemaVersion: 1
upstreams:
  product:
    url: https://example.test/team/product.git
repositories:
  root:
    upstream: product
    fallback: true
    root: true
  api:
    upstream: product
    refPrefix: api/
`);
    const root = resolveRepositoryConnection(set, "root")!;
    const api = resolveRepositoryConnection(set, "api")!;
    expect(root).toEqual({
      url: "https://example.test/team/product.git",
      refNamespace: { fallback: true, excludedPrefixes: ["api/"] }
    });
    expect(api).toEqual({
      url: "https://example.test/team/product.git",
      refNamespace: { prefix: "api/" }
    });
    expect(mapExternalRefToRepository(root.refNamespace, "refs/heads/main")).toBe("refs/heads/main");
    expect(mapExternalRefToRepository(root.refNamespace, "refs/tags/api/v1")).toBeUndefined();
    expect(mapExternalRefToRepository(api.refNamespace, "refs/heads/api/main")).toBe("refs/heads/main");
    expect(mapExternalRefToRepository(api.refNamespace, "refs/heads/main")).toBeUndefined();
    expect(mapRepositoryRefToExternal(api.refNamespace, "refs/tags/v1")).toBe("refs/tags/api/v1");
    expect(() => mapRepositoryRefToExternal(root.refNamespace, "refs/heads/api/main")).toThrow(/another repository/);
  });

  it("rejects ambiguous shared-upstream ownership", () => {
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
upstreams:
  product: {url: one}
repositories:
  root: {upstream: product, fallback: true, root: true}
  other: {upstream: product, fallback: true}
`)).toThrow(/more than one fallback/);
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
upstreams:
  product: {url: one}
repositories:
  root: {upstream: product, fallback: true, root: true}
  api: {upstream: product, refPrefix: api/}
  nested: {upstream: product, refPrefix: api/internal/}
`)).toThrow(/overlapping ref prefixes/);
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
