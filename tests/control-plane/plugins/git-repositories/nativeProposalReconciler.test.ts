import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import * as rootProofGit from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-import-proof-git.js";
import { reconcileNativeProposalRefs } from "../../../../packages/control-plane/plugins/git-review/src/native-proposal-reconciler.js";
import {
  readNativeProposalRefs
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-proposal-reconciler.js";
import { authoritativePolicy, candidateContext } from "./authoritativeNativeCandidateFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository,
  runGit
} from "./nativeRootImportFinalizeFixture.js";
import {
  nativeBundleReviewFixture,
  reviewWorkspaceId
} from "../git-ci/nativeBundleReviewFixture.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanupFinalizeFixtures(); });

describe("native proposal ref reconciliation bounds", () => {
  it("proves each branch once across a reconciliation batch and reproves the next batch", async () => {
    // Given: several proposals share the same two authoritative branch targets.
    const policyInput = { ...authoritativePolicy(), defaultRef: "refs/heads/main", branches: {
      "refs/heads/main": { review: true }, "refs/heads/development": { review: false }
    } };
    const policy = { ...policyInput, policyRevision: nativeRepositoryPolicyRevision(policyInput) };
    const fixture = await nativeBundleReviewFixture("reconciliation-proof-reuse", undefined, policy);
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const refs = ["one", "two", "three"].map((name) => `refs/heads/proposals/${reviewWorkspaceId}/${name}`);
    await runGitInput(rootRepository(fixture.root), refs.map((ref) => `update ${ref} ${candidate}\n`).join(""));
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");

    // When
    const first = await fixture.service.context.serialize(() => reconcileNativeProposalRefs(
      fixture.service.context.runtime, "project-a", "root", refs
    ));

    // Then: full checks remain per branch, rather than per proposal or process-wide.
    expect(first).toHaveLength(6);
    expect(proofs).toHaveBeenCalledTimes(2);
    expect(proofs.mock.calls.map(([input]) => input.protectedRef).sort())
      .toEqual(["refs/heads/development", "refs/heads/main"]);
    proofs.mockClear();
    const second = await fixture.service.context.serialize(() => reconcileNativeProposalRefs(
      fixture.service.context.runtime, "project-a", "root", refs
    ));
    expect(second).toHaveLength(6);
    expect(proofs).toHaveBeenCalledTimes(2);
  });

  it("rejects more than ten thousand proposal refs", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("proposal-ref-count-bound");
    await closeFinalizeService(fixture.service);
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const repository = rootRepository(fixture.root);
    const updates = Array.from({ length: 10_001 }, (_, index) =>
      `update refs/heads/proposals/${reviewWorkspaceId}/count-${index} ${candidate}\n`).join("");
    await runGitInput(repository, updates);
    const opened = await candidateContext(fixture.root);

    // When / Then
    await expect(readNativeProposalRefs(opened.context, "project-a", "root"))
      .rejects.toThrow("native proposal ref capacity is exceeded");
    await opened.close();
  }, 60_000);

  it("rejects proposal enumeration output larger than four MiB", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("proposal-ref-output-bound");
    await closeFinalizeService(fixture.service);
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const repository = rootRepository(fixture.root);
    const suffix = Array.from({ length: 5 }, () => "x".repeat(180)).join("/");
    const updates = Array.from({ length: 5_000 }, (_, index) =>
      `update refs/heads/proposals/${reviewWorkspaceId}/output-${index}-${suffix} ${candidate}\n`).join("");
    await runGitInput(repository, updates);
    const opened = await candidateContext(fixture.root);

    // When / Then
    await expect(readNativeProposalRefs(opened.context, "project-a", "root"))
      .rejects.toThrow(/stdout maxBuffer length exceeded/);
    await opened.close();
  }, 60_000);
});

function runGitInput(repository: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", ["--git-dir", repository, "update-ref", "--stdin"], {
      env: { ...process.env, LC_ALL: "C" }, stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git update-ref failed (${String(code)}): ${stderr}`));
    });
    child.stdin.end(input);
  });
}
