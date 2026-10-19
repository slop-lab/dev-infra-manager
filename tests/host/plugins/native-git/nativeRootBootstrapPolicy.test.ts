import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileNativeRepositoryBootstrapPolicy, parseNativeRootBootstrapManifestYaml } from "@slop-lab/dim-host-plugin-native-git";
import { parseRepositorySetYaml } from "../../../../packages/host/plugins/native-git/src/repositorySet.js";
import { parseNativeProjectRootImportInput } from "../../../../packages/control-plane/plugins/native-git/src/native-project-root-import-codec.js";

const review = { ciRepositoryIds: ["root"],
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
  ciRepositoryIds: [root]
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
    const fromManifest = parseNativeRootBootstrapManifestYaml(manifest(), "refs/heads/main", "root");
    const fromExplicit = compileNativeRepositoryBootstrapPolicy({
      repositoryId: "root", protectedRef: "refs/heads/main", review: {
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
      repositoryId: "root", protectedRef: fromManifest.protectedRef,
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
      .update("dim-native-policy-v4\0").update(JSON.stringify({
        protectedRef: "refs/heads/main", ciRepositoryIds: ["root"], ...reviewers
      })).digest("hex"));
    expect(fromManifest.reviewPolicy.requiredReviewRevision).toBe(createHash("sha256")
      .update("dim-native-reviewers-v1\0").update(JSON.stringify(reviewers)).digest("hex"));
    expect(() => parseRepositorySetYaml(manifest())).toThrow(/unknown field 'nativeReview'/);
  });

  it.each([
    ["zero jobs", []],
    ["ordinary only", [{ name: "source", kind: "ordinary-sysbox" }]],
    ["QEMU only", [{ name: "integration", kind: "qemu" }]],
    ["both execution kinds", review.requiredJobs]
  ] as const)("accepts %s as an explicit quality policy", (_label, requiredJobs) => {
    // Given / When
    const compiled = compileNativeRepositoryBootstrapPolicy({
      repositoryId: "root", protectedRef: "refs/heads/main", review: { ...review, requiredJobs }
    });

    // Then
    expect(compiled.reviewPolicy.requiredJobs).toHaveLength(requiredJobs.length);
  });

  it("keeps the security policy revision stable across quality-only jobset changes", () => {
    // Given
    const input = { repositoryId: "root", protectedRef: "refs/heads/main", review } as const;

    // When
    const dual = compileNativeRepositoryBootstrapPolicy(input).reviewPolicy;
    const disabled = compileNativeRepositoryBootstrapPolicy({ ...input,
      review: { ...review, requiredJobs: [] } }).reviewPolicy;

    // Then
    expect(disabled.policyRevision).toBe(dual.policyRevision);
    expect(disabled.requiredReviewRevision).toBe(dual.requiredReviewRevision);
    expect(disabled.requiredJobSetRevision).not.toBe(dual.requiredJobSetRevision);
  });

  it("rejects mismatched or unprotected reviewed root refs and unknown manifest fields", () => {
    expect(() => parseNativeRootBootstrapManifestYaml(manifest(), "refs/heads/development", "root")).toThrow();
    expect(() => parseNativeRootBootstrapManifestYaml(manifest().replace("protect: [main]", "protect: []"),
      "refs/heads/main", "root")).toThrow();
    expect(() => parseNativeRootBootstrapManifestYaml(manifest("unknown: true\n"), "refs/heads/main", "root"))
      .toThrow(/unknown/);
  });

  it("rejects unsafe refs, duplicate or untyped jobs, and unsafe reviewer rules", () => {
    const base = { repositoryId: "root", protectedRef: "refs/heads/main", review };
    expect(() => compileNativeRepositoryBootstrapPolicy({ ...base, protectedRef: "refs/heads/proposals/agent/a" }))
      .toThrow();
    expect(() => compileNativeRepositoryBootstrapPolicy({ ...base, protectedRef: "refs/heads/.hidden" }))
      .toThrow();
    expect(() => compileNativeRepositoryBootstrapPolicy({ ...base,
      review: { ...review, requiredJobs: [...review.requiredJobs, review.requiredJobs[0]] } })).toThrow();
    expect(() => compileNativeRepositoryBootstrapPolicy({ ...base,
      review: { ...review, requiredJobs: [{ name: "source", kind: "independent" }] } })).toThrow();
    expect(() => compileNativeRepositoryBootstrapPolicy({ ...base,
      review: { ...review, pathReviewerRules: [{ pathPrefix: "../../secret", reviewerIds: ["owner"] }] } })).toThrow();
    expect(() => compileNativeRepositoryBootstrapPolicy({ ...base,
      review: { ...review, extra: "untrusted" } })).toThrow();
  });

  it("accepts no path-specific reviewers but rejects nonportable reviewed origins", () => {
    const compiled = compileNativeRepositoryBootstrapPolicy({
      repositoryId: "root", protectedRef: "refs/heads/main", review: { ...review, pathReviewerRules: [] }
    });
    expect(compiled.reviewPolicy.pathReviewerRules).toEqual([]);
    expect(() => parseNativeRootBootstrapManifestYaml(
      manifest().replace("https://example.test/team/root.git", "../../root.git"), "refs/heads/main", "root"
    )).toThrow(/relative filesystem path/);
  });

  it("uses native Git's exact rule order and binds each job's execution kind", () => {
    const input = { repositoryId: "root", protectedRef: "refs/heads/main", review: {
      ...review, pathReviewerRules: [
        { pathPrefix: "a/", reviewerIds: ["owner"] },
        { pathPrefix: "Z/", reviewerIds: ["security"] }
      ]
    } } as const;
    const compiled = compileNativeRepositoryBootstrapPolicy(input);
    expect(compiled.reviewPolicy.pathReviewerRules.map(({ pathPrefix }) => pathPrefix)).toEqual(["Z/", "a/"]);
    expect(parseNativeProjectRootImportInput({ serviceId: "native-main", projectId: "project-a",
      repositoryId: "root", protectedRef: compiled.protectedRef,
      expectedCommit: "a".repeat(40), policy: compiled.reviewPolicy }).policy)
      .toEqual(compiled.reviewPolicy);
    const wrongKind = compileNativeRepositoryBootstrapPolicy({ ...input, review: {
      ...input.review, requiredJobs: [
        { name: "source", kind: "qemu" }, { name: "integration", kind: "ordinary-sysbox" }
      ]
    } });
    expect(wrongKind.reviewPolicy.requiredJobSetRevision)
      .not.toBe(compiled.reviewPolicy.requiredJobSetRevision);
    expect(wrongKind.reviewPolicy).not.toHaveProperty("requiredJobNames");
  });
});
