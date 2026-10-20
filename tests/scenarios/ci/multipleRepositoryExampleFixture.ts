import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExampleRecipe, resolveExamplePath } from "../../../scripts/examples/recipe.ts";
import { startExampleService } from "./exampleServiceFixture.js";
import { compileNativeRepositoryBootstrapPolicy } from "../../../packages/host/plugins/native-git/src/nativeRootBootstrapPolicy.js";
import { nativeGitExecutionSource } from "../../../packages/control-plane/plugins/ci/src/source.js";
import { idleNativeConfig } from "../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { addCandidateCommit, createBundleReview, reviewProposalRef, reviewWorkspaceId } from "../../control-plane/plugins/git-ci/nativeBundleReviewFixture.js";
import { activateFinalizeService, createFinalizeRoot, createRootBundle, finalizeRootImport, generationId, importer,
  parseImportReceipt, projectInput, runGit, uploadRootBundle, workspaceWriteIssuerAuthorization } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { assignment } from "../../contracts/ci/executionFixture.js";

const example = fileURLToPath(new URL("../../../examples/projects/native-multiple-repositories", import.meta.url));

/** Read the runnable example itself so changes to its policy, layout or scripts are exercised. */
async function repositoryFiles(directory: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await repositoryFiles(path, `${relative}/`));
    else if (entry.isFile()) files[relative] = await readFile(path, "utf8");
    else throw new Error(`example repository contains unsupported entry: ${relative}`);
  }
  return files;
}

export async function multipleRepositoryExampleFixture(directory = example) {
  const recipe = await loadExampleRecipe(directory);
  const root = await createFinalizeRoot("multiple-repository-example");
  const service = await startExampleService(recipe, root);
  await activateFinalizeService(service.origin);
  const snapshots: Record<string, { commit: string; tree: string }> = {};
  for (const repository of recipe.repositories) {
    const repositoryId = repository.id;
    if (!repository.policy) throw new Error("example repository policy is missing");
    const input: unknown = JSON.parse(await readFile(resolveExamplePath(recipe, repository.policy), "utf8"));
    if (typeof input !== "object" || input === null || Reflect.get(input, "schemaVersion") !== 1
      || Reflect.get(input, "repositoryId") !== repositoryId) throw new Error("invalid example repository policy");
    const policy = compileNativeRepositoryBootstrapPolicy({ repositoryId, protectedRef: "refs/heads/main", extensions: Reflect.get(input, "extensions") });
    const bundle = await createRootBundle(await repositoryFiles(resolveExamplePath(recipe, repository.path)));
    snapshots[repositoryId] = { commit: bundle.commit, tree: bundle.tree };
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a", repositoryId));
    const uploaded = await uploadRootBundle(service.origin, bundle, policy.repositoryPolicy, repositoryId);
    if (uploaded.status !== 200) throw new Error(`example ${repositoryId} import failed: ${uploaded.status}`);
    const receipt = parseImportReceipt(await uploaded.json());
    const finalized = await finalizeRootImport(service.origin, { schemaVersion: 1, generationId,
      importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest }, undefined, repositoryId);
    if (finalized.status !== 200) throw new Error(`example ${repositoryId} finalization failed: ${finalized.status}`);
  }
  const source = nativeGitExecutionSource({ ...idleNativeConfig().ci, endpoint: service.origin }, generationId);
  async function propose(repositoryId: string) {
    const response = await fetch(`${service.origin}/v1/projects/project-a/repositories/${repositoryId}/workspace-write-leases`, {
      method: "POST", headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId, workspaceId: reviewWorkspaceId })
    });
    const credential: unknown = await response.json();
    if (response.status !== 201 || typeof credential !== "object" || credential === null
      || typeof Reflect.get(credential, "username") !== "string" || typeof Reflect.get(credential, "password") !== "string") {
      throw new Error("example writer credential was not issued");
    }
    const remote = new URL(`/v1/projects/project-a/repositories/${repositoryId}.git`, service.origin);
    remote.username = Reflect.get(credential, "username"); remote.password = Reflect.get(credential, "password");
    const clone = await createFinalizeRoot(`example-${repositoryId}-writer`);
    await runGit("/usr/bin/git", ["clone", remote.href, clone]);
    await runGit("/usr/bin/git", ["-C", clone, "config", "user.name", "DIM example test"]);
    await runGit("/usr/bin/git", ["-C", clone, "config", "user.email", "test@example.invalid"]);
    await addCandidateCommit(clone, "proposal.txt", Buffer.from("reviewed example proposal\n"));
    await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    return createBundleReview(service, repositoryId);
  }
  async function authorize(repositoryId: string, jobName: string) {
    const review = await propose(repositoryId);
    const event = review.events.find((event) => event.jobName === jobName);
    if (!event) throw new Error(`example ${repositoryId}/${jobName} did not produce a runnable job`);
    return source.authorize({ ...assignment(), generationId, event });
  }
  return { root, service, source, snapshots, authorize, recipe };
}
