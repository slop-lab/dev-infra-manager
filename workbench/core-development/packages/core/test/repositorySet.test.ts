import { describe, expect, it } from "vitest";
import {
  assertRepositorySetCanCreateProject,
  assertRepositorySetUrlsArePortable,
  mapExternalRefToRepository,
  mapRepositoryRefToExternal,
  resolveRepositoryConnection,
  parseRepositorySetYaml
} from "../../../../core/packages/core/src/repositorySet.js";

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
          protectedPatterns: ["main"],
          importBranches: {},
          publishBranches: {}
        },
        api: {
          url: "git@example.test:odd/path-without-dot-git",
          fallback: false,
          root: false,
          protectedPatterns: [],
          importBranches: {},
          publishBranches: {}
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

  it("resolves reviewed publish branch mappings", () => {
    const set = parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  root:
    url: https://example.test/team/product.git
    root: true
    publish:
      main: development
`);
    expect(resolveRepositoryConnection(set, "root")).toEqual({
      url: "https://example.test/team/product.git",
      publishBranches: { main: "development" }
    });
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  root: {url: one, root: true, publish: {main: refs/heads/main}}
`)).toThrow(/safe branch name/);
  });

  it("maps explicit external archive branches onto managed branches", () => {
    const set = parseRepositorySetYaml(`
schemaVersion: 1
upstreams:
  archive: {url: https://example.test/team/archive.git}
repositories:
  root:
    upstream: archive
    root: true
    ref: main
    import: {main: dev/root}
    publish: {main: main}
  core:
    upstream: archive
    import: {main: dev/core}
    publish: {main: main}
`);
    const root = resolveRepositoryConnection(set, "root")!;
    const core = resolveRepositoryConnection(set, "core")!;
    expect(root.refNamespace).toEqual({ branches: { main: "dev/root" } });
    expect(core.refNamespace).toEqual({ branches: { main: "dev/core" } });
    expect(mapExternalRefToRepository(root.refNamespace, "refs/heads/dev/root")).toBe("refs/heads/main");
    expect(mapExternalRefToRepository(root.refNamespace, "refs/heads/dev/core")).toBeUndefined();
    expect(mapExternalRefToRepository(root.refNamespace, "refs/tags/v1")).toBeUndefined();
    expect(mapRepositoryRefToExternal(core.refNamespace, "refs/heads/main")).toBe("refs/heads/dev/core");
    expect(() => mapRepositoryRefToExternal(core.refNamespace, "refs/heads/other")).toThrow(/reviewed import/);
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
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
upstreams:
  product: {url: one}
repositories:
  root: {upstream: product, root: true, import: {main: dev/shared}}
  api: {upstream: product, import: {main: dev/shared}}
`)).toThrow(/maps external branch 'dev\/shared'/);
    expect(() => parseRepositorySetYaml(`
schemaVersion: 1
upstreams:
  product: {url: one}
repositories:
  root: {upstream: product, root: true, fallback: true}
  api: {upstream: product, import: {main: dev/api}}
`)).toThrow(/cannot mix explicit import/);
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

  it("rejects relative filesystem URLs only for managed root manifests", () => {
    const relative = parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  root: {url: ../root.git, root: true}
`);
    expect(() => assertRepositorySetUrlsArePortable(relative, ".dim/repos.yml")).toThrow(/relative filesystem path/);
    for (const url of ["/srv/git/root.git", "ssh://git@intranet/root.git", "git@intranet:root.git"]) {
      const portable = parseRepositorySetYaml(`
schemaVersion: 1
repositories:
  root: {url: "${url}", root: true}
`);
      expect(() => assertRepositorySetUrlsArePortable(portable)).not.toThrow();
    }
  });
});
