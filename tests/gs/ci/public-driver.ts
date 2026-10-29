import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CiExecutionEvidence } from "../../../packages/gs/ci-contracts/src/index.js";
import { authoritativeNativeDeliveryBinding, createCiDeliveryDispatcher, createGitCiPreparation,
  createGitCiRefUpdatePolicy, gitCiPolicyOwner, gitCiEnvelope, jsonCiDeliveryEventCodec,
  readAuthoritativeNativeReviewEnvelope as readCiEnvelope, readPendingAuthoritativeNativeDeliveries,
  recordExplicitAuthoritativeNativeDeliveryIntent } from "../../../packages/gs/ci/src/index.js";
import { repositoryPolicyRevision } from "../../../packages/gs/repository-contracts/src/index.js";
import { assertGitVersion, initializeRepository } from "../../../packages/gs/repository/src/index.js";
import { createGitRepositoryReadService, openRepositoryAuthority } from "../../../packages/gs/repository-service/src/index.js";
import { createReviewFeature,
  defaultReviewChangeMatchers } from "../../../packages/gs/review/src/index.js";

class PublicDriverError extends Error {
  readonly name = "PublicDriverError";
}

const root = process.argv[2];
if (root === undefined) throw new PublicDriverError("standalone root is required");
const execute = promisify(execFile);
const storageRoot = join(root, "storage");
const source = join(root, "source");
const selector = { namespaceId: "tenant", repositoryId: "main" } as const;
const repository = join(storageRoot, selector.namespaceId, `${selector.repositoryId}.git`);
const proposalRef = "refs/heads/review-candidate";
const statePath = join(root, "authority.sqlite3");
const binding = authoritativeNativeDeliveryBinding("portable", "portable://execution", jsonCiDeliveryEventCodec);

await mkdir(join(storageRoot, selector.namespaceId), { recursive: true });
await git(["init", source]);
await git(["-C", source, "config", "user.name", "GS CI Driver"]);
await git(["-C", source, "config", "user.email", "ci@example.invalid"]);
await writeFile(join(source, "README.md"), "initial\n");
await git(["-C", source, "add", "README.md"]);
await git(["-C", source, "commit", "-m", "initial"]);
const initialCommit = await git(["-C", source, "rev-parse", "HEAD"]);
const initialTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
const gitVersion = (await git(["--version"])).replace(/^git version /, "");
const runtime = { gitExecutable: "/usr/bin/git", gitVersion, storageRoot };
await initializeRepository(runtime, selector);
await git(["--git-dir", repository, "fetch", source, "HEAD:refs/heads/main"]);
await mkdir(join(source, "ci"), { recursive: true });
await writeFile(join(source, "ci/workflow.json"), JSON.stringify({ script: "ci/check.sh" }));
await writeFile(join(source, "ci/check.sh"), "#!/bin/sh\nexit 0\n");
await writeFile(join(source, "README.md"), "candidate\n");
await git(["-C", source, "add", "ci", "README.md"]);
await git(["-C", source, "commit", "-m", "candidate"]);
const candidateCommit = await git(["-C", source, "rev-parse", "HEAD"]);
const candidateTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
await git(["--git-dir", repository, "fetch", source, `HEAD:${proposalRef}`]);
const gitIdentity = await assertGitVersion(runtime);
const policyBase = {
  schemaVersion: 1 as const,
  protectedRef: "refs/heads/main",
  extensions: {
    "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [], changeReviewerRules: [] },
    "git-ci": {
      ciRepositoryIds: ["main"],
      requiredJobs: [{ name: "check", provider: "portable", evidenceClass: "candidate-controlled" }],
    },
  },
};
const policy = { ...policyBase, policyRevision: repositoryPolicyRevision(policyBase) };
const evidence = new Map<string, CiExecutionEvidence>();
const executionProvider = {
  name: "portable",
  revision: "a".repeat(64),
  async read(request: { readonly eventId: string }) { return evidence.get(request.eventId); },
};
let authorityEpoch = "";
let authority: Awaited<ReturnType<typeof openRepositoryAuthority>>;
const reader = createGitRepositoryReadService({ runtime, gitIdentity });
const preparation = createGitCiPreparation({
  workflow: {
    name: "portable",
    revision: "b".repeat(64),
    compiler: {
      configurationPath: "ci/workflow.json",
      compile(bytes) {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (!value || typeof value !== "object" || !("script" in value) || typeof value.script !== "string") {
          throw new PublicDriverError("workflow is invalid");
        }
        return [{ name: "check", provider: "portable", script: value.script, argv: ["/bin/sh", "/run/job"] }];
      },
    },
  },
  readers: { open: (target) => ({ executable: runtime.gitExecutable, repositoryPath: target.repositoryPath, identity: gitIdentity }) },
  async accepted({ authority: acceptedAuthority, envelope, ownerRequestId }) {
    const target = await acceptedAuthority.resolve({ ...selector, protectedRef: envelope.review.protectedRef });
    const planned = await gitCiEnvelope(target.repositoryPath, envelope);
    if (planned !== undefined) {
      await recordExplicitAuthoritativeNativeDeliveryIntent(
        target.repositoryPath,
        planned,
        acceptedAuthority.authorityEpoch,
        binding,
        ownerRequestId,
      );
    }
  },
});
const reviewFeature = createReviewFeature({
  reader,
  matchers: defaultReviewChangeMatchers(),
  preparations: [preparation],
  currentAuthorityEpoch: () => authorityEpoch,
});
const ciRefUpdatePolicy = createGitCiRefUpdatePolicy(executionProvider);
const missingProviderAuthority = await openRepositoryAuthority({
  statePath: join(root, "missing-provider.sqlite3"),
  runtime,
  gitIdentity,
  policySectionOwners: [reviewFeature.policySectionOwner, gitCiPolicyOwner],
  refUpdatePolicies: [reviewFeature.refUpdatePolicy],
});
let missingProviderDenied = false;
try {
  await missingProviderAuthority.registerRepository({
    selector,
    ownerPrincipalId: "owner",
    policy,
    branches: [{ protectedRef: "refs/heads/main", commit: initialCommit, tree: initialTree }],
  });
} catch (error) {
  if (!(error instanceof Error)) throw error;
  missingProviderDenied = /requires a selected ref-update provider/i.test(error.message);
} finally {
  await missingProviderAuthority.close();
}
authority = await openRepositoryAuthority({
  statePath,
  runtime,
  gitIdentity,
  policySectionOwners: [reviewFeature.policySectionOwner, gitCiPolicyOwner],
  refUpdatePolicies: [reviewFeature.refUpdatePolicy, ciRefUpdatePolicy],
});
authorityEpoch = authority.authorityEpoch;
await authority.registerRepository({
  selector,
  ownerPrincipalId: "owner",
  policy,
  branches: [{ protectedRef: "refs/heads/main", commit: initialCommit, tree: initialTree }],
});
const review = reviewFeature.attach({ authority, readGate: authority, mutationGate: authority });
const envelope = await review.create({ ...selector, proposalRef, requesterPrincipalId: "owner" });
await review.approve({ ...selector, reviewId: envelope.review.reviewId,
  reviewerId: "owner", requestId: "00000000-0000-4000-8000-000000000001" });
const planned = await readCiEnvelope(repository, envelope.review.reviewId);
const event = planned?.events[0];
if (planned === undefined || event === undefined) throw new PublicDriverError("CI plan is missing");
let missingEvidenceDenied = false;
const promotion = {
  ...selector,
  protectedRef: envelope.review.protectedRef,
  proposalRef: envelope.review.proposalRef,
  expectedCommit: envelope.review.expectedProtectedHead,
  candidateCommit: envelope.review.candidateCommit,
  candidateTree: envelope.review.candidateTree,
  authorizationId: envelope.review.reviewId,
  evidenceDigest: "e".repeat(64),
};
try {
  await authority.promote(promotion);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  missingEvidenceDenied = /missing/i.test(error.message);
}
evidence.set(event.eventId, {
  schemaVersion: 1,
  provider: executionProvider.name,
  providerRevision: executionProvider.revision,
  eventId: event.eventId,
  reviewId: event.reviewId,
  envelopeId: event.envelopeId,
  candidateCommit: event.candidateCommit,
  candidateTree: event.candidateTree,
  policyDigest: planned.policyDigest,
  outcome: "succeeded",
  evidenceId: "portable:check-1",
  digest: "c".repeat(64),
});
let submittedWithoutDimProfile = false;
let delivered: (() => void) | undefined;
const deliveryObserved = new Promise<void>((resolve) => { delivered = resolve; });
const dispatcher = await createCiDeliveryDispatcher({
  serviceId: binding.serviceId,
  destination: "portable://execution",
  eventCodec: jsonCiDeliveryEventCodec,
  generationId: authority.authorityEpoch,
  repositories: () => [repository],
  serialize: (operation) => operation(),
  submit: {
    async submit(input) {
      submittedWithoutDimProfile = !("profile" in input) && !("scheduler" in input);
      delivered?.();
      return { serviceId: binding.serviceId, generationId: input.generationId,
        executionId: "00000000-0000-4000-8000-000000000002" };
    },
  },
});
dispatcher.start();
await deliveryObserved;
await dispatcher.close();
const promoted = await authority.promote(promotion);
const pendingAfterDelivery = await readPendingAuthoritativeNativeDeliveries(
  repository, 1, binding, authority.authorityEpoch,
);
await authority.close();
const restartedDispatcher = await createCiDeliveryDispatcher({
  serviceId: binding.serviceId,
  destination: "portable://execution",
  eventCodec: jsonCiDeliveryEventCodec,
  generationId: authorityEpoch,
  repositories: () => [repository],
  serialize: (operation) => operation(),
  submit: { async submit() { throw new PublicDriverError("completed outbox replayed after restart"); } },
});
const restartOutboxHealthy = restartedDispatcher.healthy();
await restartedDispatcher.close();
console.log(JSON.stringify({
  candidateCommit,
  protectedHead: await git(["--git-dir", repository, "rev-parse", "refs/heads/main"]),
  missingEvidenceDenied,
  missingProviderDenied,
  submittedWithoutDimProfile,
  pendingAfterDelivery: pendingAfterDelivery.length,
  restartOutboxHealthy,
  promoted,
}));

async function git(arguments_: readonly string[]): Promise<string> {
  return (await execute("/usr/bin/git", arguments_, {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  })).stdout.trim();
}
