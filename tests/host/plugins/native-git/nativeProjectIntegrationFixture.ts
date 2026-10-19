import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bootstrapNativeProjectRepository } from "../../../../packages/host/plugins/native-git/src/nativeProjectBootstrap.js";
import { NativeProjectPendingStore } from "../../../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js";
import { createNodeNativeGitRootImporterClient } from "../../../../packages/host/plugins/native-git/src/nativeGitRootImporterClient.js";
import type { NativeControlPlaneConnection } from "../../../../packages/host/plugins/native-git/src/nativeControlPlaneConnection.js";
import { bundleSecrets } from "../../../control-plane/plugins/native-git/bundleConfigFixture.js";
import { activateFinalizeService, generationId, importer, rootReadIssuer, workspaceWriteIssuer, startFinalizeService } from "../../../control-plane/plugins/native-git/nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);
export async function managedProjectFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-managed-multi-")), state = path.join(root, "host"), serviceRoot = path.join(root, "authority");
  await mkdir(state, { mode: 0o700 }); await mkdir(serviceRoot, { mode: 0o700 });
  const service = await startFinalizeService(serviceRoot);
  await activateFinalizeService(service.origin);
  const registrarConnectionFile = path.join(root, "registrar.json"), importerConnectionFile = path.join(root, "importer.json"), hostFile = path.join(root, "host.json");
  await writeFile(registrarConnectionFile, JSON.stringify({ schemaVersion: 1, endpoint: service.origin, serviceId: "native-main", hostId: importer.hostId,
    generationId, credential: { username: "registrar-a", password: bundleSecrets.projectRegistrar } }), { mode: 0o600 });
  await writeFile(importerConnectionFile, JSON.stringify({ schemaVersion: 1, endpoint: service.origin, serviceId: "native-main", hostId: importer.hostId,
    generationId, role: "operator-root-importer", credential: { username: importer.username, password: importer.password } }), { mode: 0o600 });
  const connection: NativeControlPlaneConnection = { schemaVersion: 1, hostId: importer.hostId, nativeGit: { serviceId: "native-main", generationId,
    transport: "loopback-http", endpoint: service.origin, rootReadIssuer: { username: rootReadIssuer.username, password: rootReadIssuer.password },
    workspaceWriteIssuer: { username: workspaceWriteIssuer.username, password: workspaceWriteIssuer.password } } };
  await writeFile(hostFile, JSON.stringify(connection), { mode: 0o600 });
  const store = new NativeProjectPendingStore(state);
  await store.create({ name: "acme", projectId: "project-a", ownerHostId: importer.hostId });
  const importRepository = async (repositoryId: string, contents = repositoryId) => {
    const sourceRepository = path.join(root, repositoryId);
    await run("/usr/bin/git", ["init", "--initial-branch=main", sourceRepository]);
    await writeFile(path.join(sourceRepository, "README.md"), `${contents}\n`);
    await run("/usr/bin/git", ["-C", sourceRepository, "add", "."]);
    await run("/usr/bin/git", ["-C", sourceRepository, "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid", "commit", "-m", "import"]);
    const input = { name: "acme", projectId: "project-a", repositoryId, stateRoot: state, scratchRoot: state, sourceRepository,
      selectedRef: "refs/heads/main", gitExecutable: "/usr/bin/git", registrarConnectionFile, importerConnectionFile,
      policySource: { kind: "manifest-free" as const, review: { ciRepositoryIds: [repositoryId], requiredReviewerIds: ["owner"], requiredJobs: [], pathReviewerRules: [] } },
      signal: AbortSignal.timeout(30_000) };
    const draft = await bootstrapNativeProjectRepository(input);
    const client = await createNodeNativeGitRootImporterClient(importerConnectionFile);
    await store.admitRepository("acme", repositoryId, client, connection, AbortSignal.timeout(10_000));
    return { draft, input, sourceRepository };
  };
  return { root, state, serviceRoot, service, store, connection, hostFile, registrarConnectionFile, importerConnectionFile, importRepository };
}
