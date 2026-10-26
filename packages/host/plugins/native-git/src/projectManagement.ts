import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { nativeGitManagementOperations } from "@slop-lab/dim-service-client-native-git";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { selectedControlPlaneImporterFile } from "./controlPlaneSelection.js";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { loadNativeGitProjectRegistrarConnection } from "./nativeGitProjectRegistrarConnection.js";
import { loadNativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";
import { createNativeGitProjectRegistrarClient } from "./nativeGitProjectRegistrarClient.js";
import { createNativeGitRootImporterClient } from "./nativeGitRootImporterClient.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { nativeProjectCatalogEntry } from "./nativeProjectCatalog.js";
import { importNativeProjectPublicRepository, type PublicRepositoryImportDependencies } from "./publicRepositoryImport.js";
import { importNativeRepositoryManifest, previewNativeRepositoryManifest } from "./repositoryManifestImport.js";
async function present(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
/** Management requires distinct attested registrar and importer roles on this controller. */
export async function createNativeProjectManagement(input: { selected: NativeControlPlaneConnection; hostConnectionFile: string; reviewerId: string; environment: NodeJS.ProcessEnv }, dependencies: PublicRepositoryImportDependencies = {}) {
  let importerFile: string;
  try { importerFile = await selectedControlPlaneImporterFile(input.environment); }
  catch (error) { if (input.environment.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE !== undefined || !(error instanceof Error) || !error.message.includes("no native control plane selected")) throw error; importerFile = join(dirname(input.hostConnectionFile), "importer.json"); }
  const registrarFile = join(dirname(importerFile), "registrar.json");
  if (!await present(importerFile) || !await present(registrarFile)) return undefined;
  const importerConnection = await loadNativeGitRootImporterConnection(importerFile), registrarConnection = await loadNativeGitProjectRegistrarConnection(registrarFile), selected = input.selected;
  for (const connection of [importerConnection, registrarConnection]) if (connection.endpoint !== selected.nativeGit.endpoint || connection.hostId !== selected.hostId || connection.generationId !== selected.nativeGit.generationId) throw new Error("Project management role conflicts with the selected control-plane generation");
  if (importerConnection.credential.username === registrarConnection.credential.username || importerConnection.credential.password === registrarConnection.credential.password) throw new Error("Project management requires distinct importer and registrar credentials");
  const importer = createNativeGitRootImporterClient(importerConnection), registrar = createNativeGitProjectRegistrarClient(registrarConnection, createNodeNativeGitAdmissionHttpClient());
  await Promise.all([importer.attest(AbortSignal.timeout(10_000)), registrar.attest(AbortSignal.timeout(10_000))]);
  const stateRoot = managedStateRoot(input.environment), store = new NativeProjectPendingStore(stateRoot);
  const operations = nativeGitManagementOperations.filter((operation) => !operation.name.endsWith(".discover") && !operation.name.endsWith(".inspect") && !operation.name.endsWith(".attach"));
  return { operations, async invoke(name: string, raw: unknown): Promise<unknown> {
    const operation = operations.find((operation) => operation.name === name); if (!operation) throw new Error("Project management operation is unavailable");
    const parsed = operation.parseInput(raw);
    if (!parsed || typeof parsed !== "object" || !("projectId" in parsed) || typeof parsed.projectId !== "string") throw new Error("Invalid project management input");
    const projectId = parsed.projectId, catalog = await store.list(selected.hostId), existing = catalog.find((project) => project.projectId === projectId);
    if (name === "projects.create") {
      const record = existing ?? await store.create({ name: projectId, projectId, ownerHostId: selected.hostId });
      return operation.parseOutput(await nativeProjectCatalogEntry(record, selected));
    }
    if (!existing) throw new Error("Project does not exist on this controller");
    if ("manifest" in parsed && typeof parsed.manifest === "string") {
      if (name === "repositories.preview-manifest") {
        const plan = previewNativeRepositoryManifest(projectId, parsed.manifest, input.reviewerId);
        return operation.parseOutput({ ...plan, configurationRepositoryId: existing.configurationRepositoryId ?? plan.configurationRepositoryId, defaultWorkingRepositoryId: existing.defaultWorkingRepositoryId ?? plan.defaultWorkingRepositoryId });
      }
      return operation.parseOutput(await importNativeRepositoryManifest({ name: existing.name, projectId, manifest: parsed.manifest,
        selected, stateRoot, registrarConnectionFile: registrarFile, importerConnectionFile: importerFile, reviewerId: input.reviewerId, signal: AbortSignal.timeout(150_000) }, dependencies));
    }
    if (!("repositoryId" in parsed) || !("url" in parsed) || typeof parsed.repositoryId !== "string" || typeof parsed.url !== "string") throw new Error("Repository import input is invalid");
    const branch = "branch" in parsed && typeof parsed.branch === "string" ? parsed.branch : undefined;
    return operation.parseOutput(await importNativeProjectPublicRepository({ name: existing.name, projectId, repositoryId: parsed.repositoryId, url: parsed.url, ...(branch === undefined ? {} : { branch }),
      selected, stateRoot, registrarConnectionFile: registrarFile, importerConnectionFile: importerFile, reviewerId: input.reviewerId, signal: AbortSignal.timeout(150_000) }, dependencies));
  } };
}
