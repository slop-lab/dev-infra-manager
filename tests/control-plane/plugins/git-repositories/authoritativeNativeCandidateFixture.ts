import { gitPolicy, managedPolicyExtensions } from "../../../support/git-policy.js";
import { dimWorkflowCompiler } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { initializeNativeGitBundleState } from "../../../../packages/control-plane/plugins/git-repositories/src/index.js";
import { activationTokenSha256 } from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-activation.js";
import { assertGitVersion } from "../../../../packages/control-plane/plugins/git-repositories/src/repository.js";
import {
  activateFinalizeService,
  activationToken,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle
} from "./nativeRootImportFinalizeFixture.js";

export async function finalizedCandidateRoot(label: string, runner: string, policy: object) {
  const root = await createFinalizeRoot(`candidate-${label}`);
  const bundle = await createRootBundle({
    ".dim/ci/runner.yml": runner,
    ".dim/ci/jobs/source.bash": "set -euo pipefail\nprintf 'source\\n'\n",
    ".dim/ci/jobs/integration.bash": "set -euo pipefail\nprintf 'integration\\n'\n"
  });
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle, policy)).json());
  assert.equal((await finalizeRootImport(service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  })).status, 200);
  await closeFinalizeService(service);
  const opened = await candidateContext(root);
  return {
    root,
    repository: rootRepository(root),
    bundle,
    context: opened.context,
    selector: { projectId: "project-a", repositoryId: "root", candidateCommit: bundle.commit, candidateTree: bundle.tree },
    close: opened.close
  };
}

export async function candidateContext(
  root: string,
  servingGeneration = generationId,
  servingActivationToken = activationToken
) {
  const state = await initializeNativeGitBundleState(root, servingGeneration);
  const gitVersion = (await runGit("/usr/bin/git", ["--version"])).stdout.trim().replace("git version ", "");
  const gitIdentity = await assertGitVersion({ gitExecutable: "/usr/bin/git", gitVersion });
  return {
    context: {
      activated: () => true,
      activationTokenDigest: activationTokenSha256(servingActivationToken),
      expectedGenerationId: servingGeneration,
      gitExecutable: "/usr/bin/git",
      gitIdentity,
      workflowCompiler: dimWorkflowCompiler,
      state
    },
    close: () => state.owner.release()
  };
}

export async function objectId(
  fixture: { readonly repository: string; readonly selector: { readonly candidateTree: string } },
  path: string
): Promise<string> {
  return (await runGit("/usr/bin/git", ["--git-dir", fixture.repository, "rev-parse",
    `${fixture.selector.candidateTree}:${path}`])).stdout.trim();
}

export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function proofBytes(root: string): Promise<readonly Buffer[]> {
  return Promise.all([
    readFile(join(root, "native-idle.sqlite3")),
    readFile(join(rootRepository(root), "refs", "heads", "main"))
  ]);
}

export function matchingRunner(): string {
  return `jobs:
  source:
    script: .dim/ci/jobs/source.bash
  integration:
    script: .dim/ci/jobs/integration.bash
    runtime: vm
`;
}

export function wrongKindRunner(): string {
  return `jobs:
  integration:
    script: .dim/ci/jobs/integration.bash
  source:
    script: .dim/ci/jobs/source.bash
`;
}

export function authoritativePolicy(
  requiredReviewerIds: readonly string[] = ["owner"],
  pathReviewerRules: readonly { readonly pathPrefix: string; readonly reviewerIds: readonly string[] }[] = [],
  requiredJobs: readonly {
    readonly name: string;
    readonly kind: "ordinary-sysbox" | "qemu";
    readonly evidenceClass: "candidate-controlled";
  }[] = [
    { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" },
    { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
  ],
  ciRepositoryIds: readonly string[] = ["root"]
) {
  return gitPolicy(managedPolicyExtensions({ reviewers: requiredReviewerIds, paths: pathReviewerRules,
    jobs: requiredJobs, repositories: ciRepositoryIds }));
}
