import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { operationDescriptors } from "@slop-lab/dim-contracts-operations";
import { createNativeProjectManagement } from "./projectManagement.js";
import type { PublicRepositoryImportDependencies } from "./publicRepositoryImport.js";
import { createNativeGitOperator, nativeGitOperations } from "@slop-lab/dim-service-client-native-git";
import { selectedControlPlaneHostFile } from "./controlPlaneSelection.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { nativeProjectCatalogEntry, nativeProjectSelectionEntry } from "./nativeProjectCatalog.js";
import { createNativeProjectAttachmentManagement, nativeProjectAttachmentOperations } from "./projectAttachment.js";

async function optionalFile(path: string): Promise<string | undefined> {
  try { await lstat(path); return path; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Controller-local role credentials never cross this presentation bridge. */
async function prepareNativeProjectOperator(environment: NodeJS.ProcessEnv, expectedGeneration?: string) {
  const file = await selectedControlPlaneHostFile(environment), selected = await loadNativeControlPlaneConnection(file);
  if (expectedGeneration !== undefined && (!/^[a-f0-9]{64}$/.test(expectedGeneration) || expectedGeneration !== selected.nativeGit.generationId)) throw new Error("Selected Native Git control-plane generation changed; reconnect before continuing");
  const directory = dirname(file), promoterConnection = await optionalFile(join(directory, "promoter.json")), syncConnection = await optionalFile(join(directory, "git-sync.json"));
  const store = new NativeProjectPendingStore(managedStateRoot(environment));
  const operator = await createNativeGitOperator({ reviewerConnection: join(directory, "reviewer.json"),
    ...(promoterConnection ? { promoterConnection } : {}), ...(syncConnection ? { syncConnection } : {}),
    selectedService: { endpoint: selected.nativeGit.endpoint, generationId: selected.nativeGit.generationId, hostId: selected.hostId },
    projects: async () => (await store.list(selected.hostId)).map(nativeProjectSelectionEntry)
  });
  const catalog = async (input: unknown = {}) => {
    await operator.invoke("projects.list", input);
    return { reviewerId: operator.reviewerId,
      projects: await Promise.all((await store.list(selected.hostId)).map((project) => nativeProjectCatalogEntry(project, selected))) };
  };
  return { file, selected, operator, catalog };
}
export async function createNativeProjectConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string, dependencies: PublicRepositoryImportDependencies = {}) {
  const file = await selectedControlPlaneHostFile(environment), selected = await loadNativeControlPlaneConnection(file);
  if (expectedGeneration !== undefined && (!/^[a-f0-9]{64}$/.test(expectedGeneration) || expectedGeneration !== selected.nativeGit.generationId)) throw new Error("Selected Native Git control-plane generation changed; reconnect before continuing");
  const attachment = createNativeProjectAttachmentManagement(selected, environment);
  if (!await optionalFile(join(dirname(file), "reviewer.json"))) {
    return { generationId: selected.nativeGit.generationId, operations: attachment.operations, invoke: attachment.invoke,
      async catalog() {
        await attachment.invoke("projects.discover", {});
        const store = new NativeProjectPendingStore(managedStateRoot(environment));
        return { projects: await Promise.all((await store.list(selected.hostId)).map((project) => nativeProjectCatalogEntry(project, selected))) };
      } };
  }
  const { operator, catalog } = await prepareNativeProjectOperator(environment, expectedGeneration);
  const management = await createNativeProjectManagement({ selected, hostConnectionFile: file, reviewerId: operator.reviewerId, environment }, dependencies);
  return { generationId: selected.nativeGit.generationId, operations: [...operator.operations, ...attachment.operations, ...(management?.operations ?? [])],
    catalog,
    invoke: (name: string, input: unknown) => name === "projects.list" ? catalog(input)
      : attachment.operations.some((operation) => operation.name === name) ? attachment.invoke(name, input)
      : management?.operations.some((operation) => operation.name === name) ? management.invoke(name, input) : operator.invoke(name, input) };
}
export async function describeNativeProjectConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string) {
  const console = await createNativeProjectConsole(environment, expectedGeneration);
  const catalog = await console.catalog();
  if (!catalog || typeof catalog !== "object" || !("projects" in catalog)) throw new Error("Native Git returned an invalid project catalog");
  return { schemaVersion: 1, generationId: console.generationId, ...("reviewerId" in catalog ? { reviewerId: catalog.reviewerId } : {}),
    projects: catalog.projects, operations: operationDescriptors(console.operations) };
}
export async function invokeNativeProjectConsole(name: string, input: unknown, expectedGeneration: string, environment: NodeJS.ProcessEnv = process.env, dependencies: PublicRepositoryImportDependencies = {}): Promise<unknown> {
  if (typeof expectedGeneration !== "string") throw new Error("Native Git console invocation requires an expected generation");
  if (nativeProjectAttachmentOperations.some((operation) => operation.name === name)) {
    const file = await selectedControlPlaneHostFile(environment), selected = await loadNativeControlPlaneConnection(file);
    if (expectedGeneration !== selected.nativeGit.generationId) throw new Error("Selected Native Git control-plane generation changed; reconnect before continuing");
    return createNativeProjectAttachmentManagement(selected, environment).invoke(name, input);
  }
  // Review/sync requests need current repository scope and their own role proofs,
  // without preparing unrelated repository import/registration capabilities.
  if (nativeGitOperations.some((operation) => operation.name === name)) {
    const prepared = await prepareNativeProjectOperator(environment, expectedGeneration);
    return name === "projects.list" ? prepared.catalog(input) : prepared.operator.invoke(name, input);
  }
  return (await createNativeProjectConsole(environment, expectedGeneration, dependencies)).invoke(name, input);
}
