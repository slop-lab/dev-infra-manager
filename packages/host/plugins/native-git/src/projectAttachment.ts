import { isDeepStrictEqual } from "node:util";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
import { validateLifecycleName } from "@slop-lab/dim-host-core";
import {
  nativeRepositoryBranches,
  nativeRepositoryDefaultRef,
  type NativeGitProjectAttachment
} from "@slop-lab/dim-contracts-git";
import {
  createNativeGitProjectAttachmentClient,
  nativeGitManagementOperations
} from "@slop-lab/dim-service-client-native-git";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { parseNativeProjectPendingRecord, type NativeProjectReadyRecord } from "./nativeProjectPendingCodec.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";

const operationNames = new Set(["projects.discover", "projects.inspect", "projects.attach"]);
export const nativeProjectAttachmentOperations = nativeGitManagementOperations.filter((operation) => operationNames.has(operation.name));

export function createNativeProjectAttachmentManagement(
  selected: NativeControlPlaneConnection,
  environment: NodeJS.ProcessEnv
) {
  const client = createNativeGitProjectAttachmentClient({
    endpoint: selected.nativeGit.endpoint,
    generationId: selected.nativeGit.generationId,
    ownerHostId: selected.hostId,
    credential: selected.nativeGit.rootReadIssuer
  });
  return {
    operations: nativeProjectAttachmentOperations,
    async invoke(name: string, raw: unknown): Promise<unknown> {
      const operation = nativeProjectAttachmentOperations.find((candidate) => candidate.name === name);
      if (!operation) throw new Error("Project attachment operation is unavailable");
      const parsed = operation.parseInput(raw);
      if (name === "projects.discover") {
        const catalog = await client.discover(AbortSignal.timeout(10_000));
        return operation.parseOutput({ projects: catalog.projects.map(({ projectId, repositoryCount }) => ({ projectId, repositoryCount })) });
      }
      if (!parsed || typeof parsed !== "object" || !("projectId" in parsed) || typeof parsed.projectId !== "string") {
        throw new Error("Project attachment input is invalid");
      }
      const descriptor = await client.inspect(parsed.projectId, AbortSignal.timeout(10_000));
      if (name === "projects.inspect") return operation.parseOutput(inspect(descriptor));
      if (!("configurationRepositoryId" in parsed) || typeof parsed.configurationRepositoryId !== "string"
        || !("defaultWorkingRepositoryId" in parsed) || typeof parsed.defaultWorkingRepositoryId !== "string") {
        throw new Error("Project attachment defaults are invalid");
      }
      const nameValue = "name" in parsed && typeof parsed.name === "string" ? parsed.name : parsed.projectId;
      const record = attachmentRecord(descriptor, validateLifecycleName(nameValue, "project"), {
        configurationRepositoryId: parsed.configurationRepositoryId,
        defaultWorkingRepositoryId: parsed.defaultWorkingRepositoryId
      });
      const signal = AbortSignal.timeout(30_000);
      for (const repository of Object.values(record.repositories)) {
        await proveNativeProjectReadiness(selected, record, repository.repositoryId, signal, {
          commit: repository.commit,
          tree: repository.tree,
          protectedRef: repository.protectedRef,
          allowFastForward: true
        });
      }
      const attached = await new NativeProjectPendingStore(managedStateRoot(environment)).attach(record);
      return operation.parseOutput({ projectId: attached.projectId, repositoryCount: Object.keys(attached.repositories).length });
    }
  };
}

function inspect(descriptor: NativeGitProjectAttachment) {
  return {
    projectId: descriptor.projectId,
    repositories: [...descriptor.repositories].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
      .map(({ repositoryId, effectivePolicy }) => ({
        repositoryId,
        defaultRef: nativeRepositoryDefaultRef(effectivePolicy),
        branches: Object.keys(nativeRepositoryBranches(effectivePolicy)).sort()
      }))
  };
}

function attachmentRecord(
  descriptor: NativeGitProjectAttachment,
  name: string,
  selection: { readonly configurationRepositoryId: string; readonly defaultWorkingRepositoryId: string }
): NativeProjectReadyRecord {
  const { configurationRepositoryId, defaultWorkingRepositoryId } = selection;
  const repositoryIds = new Set(descriptor.repositories.map(({ repositoryId }) => repositoryId));
  if (!repositoryIds.has(configurationRepositoryId) || !repositoryIds.has(defaultWorkingRepositoryId)) {
    throw new Error("Project attachment defaults must select discovered repositories");
  }
  const readyAt = new Date().toISOString();
  const repositories = Object.fromEntries([...descriptor.repositories]
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
    .map(({ repositoryId, importReceipt, importedPolicy, effectivePolicy }) => [repositoryId, {
      repositoryId,
      phase: "ready",
      protectedRef: importReceipt.protectedRef,
      commit: importReceipt.expectedCommit,
      tree: importReceipt.resolvedTree,
      repositoryPolicy: effectivePolicy,
      ...(isDeepStrictEqual(importedPolicy, effectivePolicy) ? {} : { importedPolicy }),
      importReceipt,
      bundleDigest: importReceipt.bundleDigest,
      bundleSize: importReceipt.bundleSize,
      readyAt
    }]));
  const record = parseNativeProjectPendingRecord({
    schemaVersion: 7,
    recordType: "native-project",
    phase: "ready",
    name,
    projectId: descriptor.projectId,
    serviceId: "native-main",
    ownerHostId: descriptor.ownerHostId,
    configurationRepositoryId,
    defaultWorkingRepositoryId,
    repositories,
    readyAt
  });
  if (record.phase !== "ready") throw new Error("Project attachment record is invalid");
  return record;
}
