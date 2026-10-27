import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { ensureConfiguredRepositoryBranches } from "./repository-branches.js";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import { NativeGitBundleHttpError, readBoundedJson, sendJson, sendNotFound } from "./native-bundle-http.js";
import type { RootImportHttpContext } from "./native-project-root-import-http.js";
import { parseAuthoritativeImportedRootPolicy } from "./native-imported-root-policy.js";
import { assertImportedRepositorySnapshotCurrent, verifyLiveImportedRepository, NativeImportedRootNotFoundError, NativeImportedRootInactiveError } from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { RepositoryRefStateError } from "./repository-ref-state.js";
import { NativeProjectStorageError } from "./native-project-storage.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";
import { updateRepositoryPolicy } from "./repository-policy-state.js";

const updateSchema = z.object({ schemaVersion: z.literal(1), expectedPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/), expectedProtectedHead: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), policy: z.unknown() }).strict();

export async function handleNativeRepositoryPolicyHttp(context: RootImportHttpContext): Promise<boolean> {
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/policy$/.exec(context.pathname);
  if (match === null) return false;
  const projectId = match[1], repositoryId = match[2];
  if (projectId === undefined || repositoryId === undefined || !["GET", "POST"].includes(context.request.method ?? "") || context.importers.length === 0) { sendNotFound(context.response); return true; }
  const authorized = (credential: { readonly username: string; readonly password: string }) => {
    const supplied = Buffer.from(context.request.headers.authorization ?? "");
    const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const importer = context.importers.find(authorized);
  if (importer === undefined) { const known = context.knownCredentials.some(authorized); sendJson(context.response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" }); return true; }
  if (!context.activated || !exactActivationIsBound(context.state, context.expectedGenerationId, context.activationTokenDigest)) { sendJson(context.response, 503, { error: "native Git business operations require exact generation activation" }); return true; }
  if (context.request.headers["x-dim-generation-id"] !== context.expectedGenerationId) { sendJson(context.response, 409, { error: "repository policy generation conflicts with service startup" }); return true; }
  try {
    const update = context.request.method === "POST" ? updateSchema.parse(await readBoundedJson(context.request)) : undefined;
    let policy: ReturnType<typeof parseAuthoritativeImportedRootPolicy> | undefined;
    if (update !== undefined) {
      try { policy = parseAuthoritativeImportedRootPolicy(update.policy); }
      catch (error) { throw new NativeProjectRootImportStateError("repository policy is invalid", { cause: error }); }
    }
    const run = update === undefined ? context.read
      : <Result>(operation: () => Promise<Result>) => context.mutate({ projectId, repositoryId }, operation);
    await run(async () => {
      const verify = () => verifyLiveImportedRepository({ activated: context.activated, activationTokenDigest: context.activationTokenDigest, expectedGenerationId: context.expectedGenerationId, gitExecutable: context.gitExecutable, gitIdentity: context.gitIdentity, ownerHostId: importer.hostId, projectId, repositoryId, state: context.state, stateDirectory: context.stateDirectory });
      // A retry may follow a committed policy whose branch publication was interrupted.
      // Recover only baselines already authorized by the effective stored policy.
      if (update !== undefined && readNativeProjectRootImportsFromDatabase(context.state.database).some((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId && entry.ownerHostId === importer.hostId)) await ensureConfiguredRepositoryBranches({ database: context.state.database, stateDirectory: context.stateDirectory, gitExecutable: context.gitExecutable, gitIdentity: context.gitIdentity }, projectId, repositoryId);
      let live = await verify();
      if (update !== undefined && policy !== undefined) {
        if (live.currentHead.commit !== update.expectedProtectedHead || live.imported.policyDigest !== update.expectedPolicyDigest || policy.protectedRef !== live.currentHead.protectedRef) throw new RepositoryRefStateError("repository policy compare-and-swap conflicts");
        await context.validatePolicy(policy, { projectId, repositoryId });
        await assertImportedRepositorySnapshotCurrent({ gitExecutable: context.gitExecutable, gitIdentity: context.gitIdentity,
          ownerHostId: importer.hostId, projectId, repositoryId, state: context.state,
          stateDirectory: context.stateDirectory, expected: live });
        updateRepositoryPolicy(context.state.database, { projectId, repositoryId, ownerHostId: importer.hostId, generationId: context.expectedGenerationId, expectedPolicyDigest: update.expectedPolicyDigest, expectedProtectedHead: update.expectedProtectedHead, policy });
        await ensureConfiguredRepositoryBranches({ database: context.state.database, stateDirectory: context.stateDirectory, gitExecutable: context.gitExecutable, gitIdentity: context.gitIdentity }, projectId, repositoryId);
        await context.reconcilePolicy(projectId, repositoryId);
        live = await verify();
      }
      sendJson(context.response, 200, { schemaVersion: 1, projectId, repositoryId, protectedRef: live.currentHead.protectedRef, currentHead: live.currentHead, policy: live.imported.policy, policyDigest: live.imported.policyDigest });
    });
  } catch (error) {
    if (error instanceof NativeImportedRootNotFoundError) sendNotFound(context.response);
    else if (error instanceof NativeImportedRootInactiveError) sendJson(context.response, 503, { error: "native Git business operations require exact generation activation" });
    else if (error instanceof RepositoryRefStateError || error instanceof NativeProjectStorageError || error instanceof NativeRootImportBundleError) sendJson(context.response, 409, { error: "repository policy compare-and-swap or imported root conflicts" });
    else if (error instanceof NativeGitBundleHttpError || error instanceof z.ZodError || error instanceof NativeProjectRootImportStateError) sendJson(context.response, 400, { error: "repository policy request is invalid" });
    else throw error;
  }
  return true;
}
