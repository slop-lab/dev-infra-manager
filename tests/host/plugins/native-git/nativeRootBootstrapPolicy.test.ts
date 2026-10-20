import { describe, expect, it } from "vitest";
import { compileNativeRepositoryBootstrapPolicy, parseNativeRootBootstrapManifestYaml } from "@slop-lab/dim-host-plugin-native-git";
import { parseNativeProjectRootImportInput } from "../../../../packages/control-plane/plugins/git-repositories/src/native-project-root-import-codec.js";
const extensions = {
  "code-review": { requiredReviewerIds: ["owner", "security"], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["security"] }] },
  "git-ci": { ciRepositoryIds: ["root"], requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }, { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" }] },
  "merge-policy": {}
};
function manifest(policy = `policy:\n  code-review:\n    requiredReviewerIds: [owner, security]\n    pathReviewerRules: [{pathPrefix: .dim/, reviewerIds: [security]}]\n  git-ci:\n    ciRepositoryIds: [root]\n    requiredJobs: [{name: source, kind: ordinary-sysbox, evidenceClass: candidate-controlled}, {name: integration, kind: qemu, evidenceClass: candidate-controlled}]\n  merge-policy: {}\n`): string {
  return `schemaVersion: 1\nrepositories:\n  root: {url: https://example.test/team/root.git, root: true, ref: main, protect: [main]}\n${policy}`;
}
describe("repository bootstrap policy", () => {
  it("transports namespaced feature declarations and binds the whole policy", () => {
    const compiled = parseNativeRootBootstrapManifestYaml(manifest(), "refs/heads/main", "root");
    expect(compiled).toEqual(compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main", extensions }));
    expect(compiled.repositoryPolicy.extensions).toEqual(extensions);
    expect(compiled.repositoryPolicy.policyRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(parseNativeProjectRootImportInput({ serviceId: "native-main", projectId: "project-a", repositoryId: "root", protectedRef: compiled.protectedRef,
      expectedCommit: "a".repeat(40), policy: compiled.repositoryPolicy }).policy).toEqual(compiled.repositoryPolicy);
  });
  it("rejects obsolete explicit recipe fields rather than silently dropping their requirements", () => {
    const obsolete = { repositoryId: "root", protectedRef: "refs/heads/main", review: { requiredReviewerIds: ["owner"] } };
    expect(() => compileNativeRepositoryBootstrapPolicy(obsolete)).toThrow(/unknown fields/);
  });
  it("supports repository-only manifests and explicit input without requiring review or CI", () => {
    const explicit = compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main" });
    expect(explicit.repositoryPolicy.extensions).toEqual({});
    expect(parseNativeRootBootstrapManifestYaml(manifest(""), "refs/heads/main", "root")).toEqual(explicit);
  });
  it("changes approval-bound policy identity when quality requirements change", () => {
    const compile = (value: unknown) => compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main", extensions: value }).repositoryPolicy.policyRevision;
    expect(compile({ ...extensions, "git-ci": { ...extensions["git-ci"], requiredJobs: [] } })).not.toBe(compile(extensions));
    expect(compile({ "merge-policy": {}, "git-ci": extensions["git-ci"], "code-review": extensions["code-review"] })).toBe(compile(extensions));
  });
  it("leaves feature-specific validation with the feature owner", () => {
    const custom = { "artifact-check": { mode: "reviewed", names: ["custom"] } };
    expect(compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main", extensions: custom }).repositoryPolicy.extensions).toEqual(custom);
  });
  it("rejects malformed extension containers, namespaces and oversized policies", () => {
    for (const value of [[], "invalid", { "invalid namespace": {} }, { "custom": "x".repeat(65 * 1024) }]) {
      expect(() => compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main", extensions: value })).toThrow();
    }
  });
  it("rejects unknown manifest fields, duplicate keys and obsolete unnamespaced review recipes", () => {
    for (const extra of ["unknown: true\n", "nativeReview: {}\n", "policy: {}\npolicy: {}\n"]) expect(() => parseNativeRootBootstrapManifestYaml(manifest(extra), "refs/heads/main", "root")).toThrow();
  });
  it("rejects unsafe repository identities, unprotected refs and nonportable origins", () => {
    for (const repositoryId of ["root.bad", "root_bad", "../root"]) expect(() => compileNativeRepositoryBootstrapPolicy({ repositoryId, protectedRef: "refs/heads/main" })).toThrow();
    for (const protectedRef of ["refs/heads/proposals/agent/a", "refs/heads/.hidden", "refs/heads/main/../secret"]) expect(() => compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef })).toThrow();
    expect(() => parseNativeRootBootstrapManifestYaml(manifest(), "refs/heads/development", "root")).toThrow();
    expect(() => parseNativeRootBootstrapManifestYaml(manifest().replace("protect: [main]", "protect: []"), "refs/heads/main", "root")).toThrow();
    expect(() => parseNativeRootBootstrapManifestYaml(manifest().replace("https://example.test/team/root.git", "../../root.git"), "refs/heads/main", "root")).toThrow(/relative filesystem path/);
  });
});
