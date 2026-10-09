import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compileNativeRootBootstrapPolicy,
  parseNativeRootBootstrapManifestYaml
} from "../../../../core/packages/core/src/index.js";
import { parseRepositorySetYaml } from "../../../../core/packages/core/src/repositorySet.js";
import { parseNativeProjectRootImportInput } from "../../../../core/packages/native-git/src/native-project-root-import-codec.js";

const review = {
  requiredReviewerIds: ["owner", "security"],
  pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["security"] }],
  requiredJobs: [{ name: "source", kind: "ordinary-sysbox" }, { name: "integration", kind: "qemu" }]
} as const;

function manifest(override = ""): string {
  return `schemaVersion: 1
repositories:
  root:
    url: https://example.test/team/root.git
    root: true
    ref: main
    protect: [main]
nativeReview:
  requiredReviewerIds: [owner, security]
  pathReviewerRules:
    - pathPrefix: .dim/
      reviewerIds: [security]
  requiredJobs:
    - {name: source, kind: ordinary-sysbox}
    - {name: integration, kind: qemu}
${override}`;
}

describe("native root bootstrap policy", () => {
  it("binds reviewed manifest and explicit input to the same canonical policy", () => {
    const fromManifest = parseNativeRootBootstrapManifestYaml(manifest(), "refs/heads/main");
    const fromExplicit = compileNativeRootBootstrapPolicy({
      rootAlias: "root", protectedRef: "refs/heads/main", review: {
        ...review, requiredReviewerIds: ["security", "owner"],
        requiredJobs: [...review.requiredJobs].reverse()
      }
    });
    expect(fromManifest).toEqual(fromExplicit);
    expect(fromManifest.reviewPolicy).toMatchObject({
      schemaVersion: 1, protectedRef: "refs/heads/main",
      requiredJobs: [
        { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" },
        { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
      ],
      requiredReviewerIds: ["owner", "security"]
    });
    expect(parseNativeProjectRootImportInput({ serviceId: "native-main", projectId: "project-a",
      rootRepositoryId: "root", protectedRef: fromManifest.protectedRef,
      expectedCommit: "a".repeat(40), policy: fromManifest.reviewPolicy }).policy)
      .toEqual(fromManifest.reviewPolicy);
    for (const revision of [fromManifest.reviewPolicy.policyRevision,
      fromManifest.reviewPolicy.requiredReviewRevision, fromManifest.reviewPolicy.requiredJobSetRevision]) {
      expect(revision).toMatch(/^[0-9a-f]{64}$/);
    }
    const jobs = fromManifest.reviewPolicy.requiredJobs;
    const reviewers = { requiredReviewerIds: ["owner", "security"],
      pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["security"] }] };
    expect(fromManifest.reviewPolicy.requiredJobSetRevision).toBe(createHash("sha256")
      .update("dim-native-jobs-v2\0").update(JSON.stringify(jobs)).digest("hex"));
    expect(fromManifest.reviewPolicy.policyRevision).toBe(createHash("sha256")
      .update("dim-native-policy-v2\0").update(JSON.stringify({
        protectedRef: "refs/heads/main", ...reviewers, requiredJobs: jobs
      })).digest("hex"));
    expect(fromManifest.reviewPolicy.requiredReviewRevision).toBe(createHash("sha256")
      .update("dim-native-reviewers-v1\0").update(JSON.stringify(reviewers)).digest("hex"));
    expect(() => parseRepositorySetYaml(manifest())).toThrow(/unknown field 'nativeReview'/);
  });

  it("rejects mismatched or unprotected reviewed root refs and unknown manifest fields", () => {
    expect(() => parseNativeRootBootstrapManifestYaml(manifest(), "refs/heads/development")).toThrow();
    expect(() => parseNativeRootBootstrapManifestYaml(manifest().replace("protect: [main]", "protect: []"),
      "refs/heads/main")).toThrow();
    expect(() => parseNativeRootBootstrapManifestYaml(manifest("unknown: true\n"), "refs/heads/main"))
      .toThrow(/unknown/);
  });

  it("rejects unsafe refs, duplicate or untyped jobs, and unsafe reviewer rules", () => {
    const base = { rootAlias: "root", protectedRef: "refs/heads/main", review };
    expect(() => compileNativeRootBootstrapPolicy({ ...base, protectedRef: "refs/heads/proposals/agent/a" }))
      .toThrow();
    expect(() => compileNativeRootBootstrapPolicy({ ...base, protectedRef: "refs/heads/.hidden" }))
      .toThrow();
    expect(() => compileNativeRootBootstrapPolicy({ ...base,
      review: { ...review, requiredJobs: [...review.requiredJobs, review.requiredJobs[0]] } })).toThrow();
    expect(() => compileNativeRootBootstrapPolicy({ ...base,
      review: { ...review, requiredJobs: [{ name: "source", kind: "independent" }] } })).toThrow();
    expect(() => compileNativeRootBootstrapPolicy({ ...base,
      review: { ...review, pathReviewerRules: [{ pathPrefix: "../secret", reviewerIds: ["owner"] }] } })).toThrow();
    expect(() => compileNativeRootBootstrapPolicy({ ...base,
      review: { ...review, extra: "untrusted" } })).toThrow();
  });

  it("accepts no path-specific reviewers but rejects nonportable reviewed origins", () => {
    const compiled = compileNativeRootBootstrapPolicy({
      rootAlias: "root", protectedRef: "refs/heads/main", review: { ...review, pathReviewerRules: [] }
    });
    expect(compiled.reviewPolicy.pathReviewerRules).toEqual([]);
    expect(() => parseNativeRootBootstrapManifestYaml(
      manifest().replace("https://example.test/team/root.git", "../root.git"), "refs/heads/main"
    )).toThrow(/relative filesystem path/);
  });

  it("uses native Git's exact rule order and binds each job's execution kind", () => {
    const input = { rootAlias: "root", protectedRef: "refs/heads/main", review: {
      ...review, pathReviewerRules: [
        { pathPrefix: "a/", reviewerIds: ["owner"] },
        { pathPrefix: "Z/", reviewerIds: ["security"] }
      ]
    } } as const;
    const compiled = compileNativeRootBootstrapPolicy(input);
    expect(compiled.reviewPolicy.pathReviewerRules.map(({ pathPrefix }) => pathPrefix)).toEqual(["Z/", "a/"]);
    expect(parseNativeProjectRootImportInput({ serviceId: "native-main", projectId: "project-a",
      rootRepositoryId: "root", protectedRef: compiled.protectedRef,
      expectedCommit: "a".repeat(40), policy: compiled.reviewPolicy }).policy)
      .toEqual(compiled.reviewPolicy);
    const wrongKind = compileNativeRootBootstrapPolicy({ ...input, review: {
      ...input.review, requiredJobs: [
        { name: "source", kind: "qemu" }, { name: "integration", kind: "ordinary-sysbox" }
      ]
    } });
    expect(wrongKind.reviewPolicy.requiredJobSetRevision)
      .not.toBe(compiled.reviewPolicy.requiredJobSetRevision);
    expect(wrongKind.reviewPolicy).not.toHaveProperty("requiredJobNames");
  });
});
