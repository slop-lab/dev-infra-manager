import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { operationDescriptors } from "@slop-lab/dim-contracts-operations";
import { createNativeGitOperator } from "@slop-lab/dim-native-git-client";
import { selectedControlPlaneHostFile } from "./controlPlaneSelection.js";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";

async function optionalFile(path: string): Promise<string | undefined> {
  try { await lstat(path); return path; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Controller-local role credentials never cross this presentation bridge. */
export async function createNativeProjectConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string) {
  const file = await selectedControlPlaneHostFile(environment), selected = await loadNativeControlPlaneConnection(file);
  if (expectedGeneration !== undefined && (!/^[a-f0-9]{64}$/.test(expectedGeneration) || expectedGeneration !== selected.nativeGit.generationId)) throw new Error("Selected Native Git control-plane generation changed; reconnect before continuing");
  const directory = dirname(file), promoterConnection = await optionalFile(join(directory, "promoter.json")), syncConnection = await optionalFile(join(directory, "git-sync.json"));
  const store = new NativeProjectPendingStore(managedStateRoot(environment));
  const operator = await createNativeGitOperator({ reviewerConnection: join(directory, "reviewer.json"),
    ...(promoterConnection ? { promoterConnection } : {}), ...(syncConnection ? { syncConnection } : {}),
    selectedService: { endpoint: selected.nativeGit.endpoint, generationId: selected.nativeGit.generationId, hostId: selected.hostId },
    projects: async () => (await store.list(selected.hostId)).map((project) => ({ projectId: project.projectId, name: project.name,
      repositoryIds: Object.values(project.repositories).filter((repository) => repository.phase === "ready" && repository.importReceipt.generationId === selected.nativeGit.generationId).map(({ repositoryId }) => repositoryId).sort() }))
  });
  return { generationId: selected.nativeGit.generationId, ...operator };
}
export async function describeNativeProjectConsole(environment: NodeJS.ProcessEnv = process.env, expectedGeneration?: string) {
  const console = await createNativeProjectConsole(environment, expectedGeneration);
  const catalog = await console.invoke("projects.list", {});
  if (!catalog || typeof catalog !== "object" || !("reviewerId" in catalog) || !("projects" in catalog)) throw new Error("Native Git returned an invalid project catalog");
  return { schemaVersion: 1, generationId: console.generationId, reviewerId: catalog.reviewerId, projects: catalog.projects, operations: operationDescriptors(console.operations) };
}
export async function invokeNativeProjectConsole(name: string, input: unknown, expectedGeneration: string, environment: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  if (typeof expectedGeneration !== "string") throw new Error("Native Git console invocation requires an expected generation");
  return (await createNativeProjectConsole(environment, expectedGeneration)).invoke(name, input);
}
