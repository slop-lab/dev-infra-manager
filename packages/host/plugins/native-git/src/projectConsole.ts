import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { operationDescriptors } from "@slop-lab/dim-contracts-operations";
import { createNativeProjectManagement } from "./projectManagement.js";
import type { PublicRepositoryImportDependencies } from "./publicRepositoryImport.js";
import { createNativeGitOperator } from "@slop-lab/dim-native-git-client";
import { selectedControlPlaneHostFile } from "./controlPlaneSelection.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { nativeProjectCatalogEntry } from "./nativeProjectCatalog.js";

async function optionalFile(path: string): Promise<string | undefined> {
  try { await lstat(path); return path; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Controller-local role credentials never cross this presentation bridge. */
export async function createNativeProjectConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string, dependencies: PublicRepositoryImportDependencies = {}) {
  const file = await selectedControlPlaneHostFile(environment), selected = await loadNativeControlPlaneConnection(file);
  if (expectedGeneration !== undefined && (!/^[a-f0-9]{64}$/.test(expectedGeneration) || expectedGeneration !== selected.nativeGit.generationId)) throw new Error("Selected Native Git control-plane generation changed; reconnect before continuing");
  const directory = dirname(file), promoterConnection = await optionalFile(join(directory, "promoter.json")), syncConnection = await optionalFile(join(directory, "git-sync.json"));
  const store = new NativeProjectPendingStore(managedStateRoot(environment));
  const operator = await createNativeGitOperator({ reviewerConnection: join(directory, "reviewer.json"),
    ...(promoterConnection ? { promoterConnection } : {}), ...(syncConnection ? { syncConnection } : {}),
    selectedService: { endpoint: selected.nativeGit.endpoint, generationId: selected.nativeGit.generationId, hostId: selected.hostId },
    projects: async () => Promise.all((await store.list(selected.hostId)).map((project) => nativeProjectCatalogEntry(project, selected)))
  });
  const catalog = await operator.invoke("projects.list", {});
  if (!catalog || typeof catalog !== "object" || !("reviewerId" in catalog) || typeof catalog.reviewerId !== "string") throw new Error("Invalid Native Git reviewer identity");
  const management = await createNativeProjectManagement({ selected, hostConnectionFile: file, reviewerId: catalog.reviewerId, environment }, dependencies);
  return { generationId: selected.nativeGit.generationId, operations: [...operator.operations, ...(management?.operations ?? [])],
    invoke: (name: string, input: unknown) => management?.operations.some((operation) => operation.name === name) ? management.invoke(name, input) : operator.invoke(name, input) };
}
export async function describeNativeProjectConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string) {
  const console = await createNativeProjectConsole(environment, expectedGeneration);
  const catalog = await console.invoke("projects.list", {});
  if (!catalog || typeof catalog !== "object" || !("reviewerId" in catalog) || !("projects" in catalog)) throw new Error("Native Git returned an invalid project catalog");
  return { schemaVersion: 1, generationId: console.generationId, reviewerId: catalog.reviewerId, projects: catalog.projects, operations: operationDescriptors(console.operations) };
}
export async function invokeNativeProjectConsole(name: string, input: unknown, expectedGeneration: string, environment: NodeJS.ProcessEnv = process.env, dependencies: PublicRepositoryImportDependencies = {}): Promise<unknown> {
  if (typeof expectedGeneration !== "string") throw new Error("Native Git console invocation requires an expected generation");
  return (await createNativeProjectConsole(environment, expectedGeneration, dependencies)).invoke(name, input);
}
