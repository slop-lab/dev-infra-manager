import { checkRefUpdatePolicies } from "./ref-update-policies.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { atomicPromote, candidateDescendsFrom } from "./promotion-git.js";
import { resolveAuthoritativeNativeRepositoryTarget } from "./authoritative-native-root-target.js";
import { assertGitExecutableIdentity } from "./repository.js";
import { saveRepositoryRefIntent, finalizeRepositoryRef, readRepositoryRefTransitions, assertRepositoryRefTransitions, cancelRepositoryRefIntent, type RepositoryRefTransition } from "./repository-ref-state.js";
import type { RepositoryExtensionContext, RepositoryRuntime } from "./plugin-api.js";
const execute = promisify(execFile);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const protectedRefChangeSchema = z.object({ projectId: identifier, repositoryId: identifier,
  proposalRef: z.string().regex(/^refs\/heads\/proposals\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9._/-]+$/).refine((value) => !value.includes("..") && !value.includes("//") && !value.includes("/.") && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock")),
  expectedCommit: objectId, candidateCommit: objectId, candidateTree: objectId, authorizationId: digest, evidenceDigest: digest
}).strict().readonly();
export type ProtectedRefChange = z.infer<typeof protectedRefChangeSchema>;
export async function compareAndSwapProtectedRef(context: RepositoryExtensionContext, input: ProtectedRefChange): Promise<{ readonly outcome: "promoted" | "already-current"; readonly sequence: number }> {
  input = protectedRefChangeSchema.parse(input);
  const target = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, { projectId: input.projectId, repositoryId: input.repositoryId });
  const config = { gitExecutable: context.runtime.gitExecutable, storageRoot: context.stateDirectory };
  if (target.currentHead.commit !== input.expectedCommit) {
    const database = new DatabaseSync(context.runtime.state.database, { readOnly: true });
    try {
      const previous = readRepositoryRefTransitions(database).find(({ transition, finalized }) => finalized && transition.projectId === input.projectId && transition.repositoryId === input.repositoryId && transition.authorizationId === input.authorizationId);
      if (previous !== undefined && previous.transition.candidateCommit === input.candidateCommit && previous.transition.candidateTree === input.candidateTree && previous.transition.evidenceDigest === input.evidenceDigest && target.currentHead.commit === input.candidateCommit) return { outcome: "already-current", sequence: previous.transition.sequence };
    } finally { database.close(); }
    throw new Error("protected ref compare-and-swap head conflicts");
  }
  if (!await candidateDescendsFrom(config, input, input.expectedCommit, input.candidateCommit)) throw new Error("protected ref candidate does not descend from the current head");
  await assertGitExecutableIdentity(context.runtime.gitExecutable, context.runtime.gitIdentity);
  const tree = await execute(context.runtime.gitExecutable, ["--no-replace-objects", "--git-dir", target.repository, "rev-parse", "--verify", `${input.candidateCommit}^{tree}`], { env: gitEnvironment(), maxBuffer: 1024, timeout: 30_000 });
  if (tree.stdout.trim() !== input.candidateTree) throw new Error("protected ref candidate tree conflicts");
  const refPolicyRevision = await checkRefUpdatePolicies(context, target, input);
  const current = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, { projectId: input.projectId, repositoryId: input.repositoryId });
  if (JSON.stringify(current) !== JSON.stringify(target)) throw new Error("repository changed during ref update authorization");
  await assertGitExecutableIdentity(context.runtime.gitExecutable, context.runtime.gitIdentity);
  const transition: RepositoryRefTransition = { ...input, expectedTree: target.currentHead.tree, protectedRef: target.currentHead.protectedRef,
    sequence: target.currentHead.sequence + 1, importNonce: target.imported.importNonce,
    generationId: context.runtime.expectedGenerationId, refPolicyRevision, policyDigest: target.imported.policyDigest };
  saveRepositoryRefIntent(context.runtime.state.database, transition);
  if (!await atomicPromote(config, transition, input.expectedCommit, input.candidateCommit)) throw new Error("protected ref compare-and-swap failed; recovery is required");
  finalizeRepositoryRef(context.runtime.state.database, transition);
  return { outcome: "promoted", sequence: transition.sequence };
}
export async function recoverRepositoryRefChanges(runtime: Pick<RepositoryRuntime, "state" | "gitExecutable" | "gitIdentity">, stateDirectory: string): Promise<void> {
  const database = new DatabaseSync(runtime.state.database, { readOnly: true });
  const pending = (() => { try { assertRepositoryRefTransitions(database); return readRepositoryRefTransitions(database).filter((entry) => !entry.finalized); } finally { database.close(); } })();
  for (const { transition } of pending) {
    await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
    const repository = join(stateDirectory, transition.projectId, `${transition.repositoryId}.git`);
    const tree = await execute(runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repository, "rev-parse", "--verify", `${transition.candidateCommit}^{tree}`], { env: gitEnvironment(), maxBuffer: 1024, timeout: 30_000 });
    if (tree.stdout.trim() !== transition.candidateTree || !await candidateDescendsFrom({ gitExecutable: runtime.gitExecutable, storageRoot: stateDirectory }, transition, transition.expectedCommit, transition.candidateCommit)) throw new Error("pending repository ref candidate is invalid");
    const result = await execute(runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repository, "rev-parse", "--verify", transition.protectedRef], { env: gitEnvironment(), maxBuffer: 1024, timeout: 30_000 });
    if (result.stdout.trim() === transition.expectedCommit) {
      // An intent is not permission to replay after policy or approval changes.
      cancelRepositoryRefIntent(runtime.state.database, transition);
      continue;
    } else if (result.stdout.trim() !== transition.candidateCommit) throw new Error("pending repository ref change conflicts with Git state");
    finalizeRepositoryRef(runtime.state.database, transition);
  }
}
function gitEnvironment(): NodeJS.ProcessEnv { return { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", HOME: "/dev/null", LC_ALL: "C" }; }

export function readProtectedRefTransition(runtime: RepositoryRuntime, authorizationId: string): RepositoryRefTransition | undefined {
  const database = new DatabaseSync(runtime.state.database, { readOnly: true, defensive: true });
  try { return readRepositoryRefTransitions(database).find((entry) => entry.finalized && entry.transition.authorizationId === authorizationId)?.transition; } finally { database.close(); }
}
