import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeProjectConsole, describeNativeProjectConsole } from "../../../../packages/host/plugins/native-git/src/projectConsole.js";
import { runNativeGitCli } from "../../../../packages/host/plugins/native-git/src/cli/index.js";
import { NativeProjectPendingStore } from "../../../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js";
import { createNativeRepositoryPolicyClient } from "../../../../packages/host/plugins/native-git/src/nativeRepositoryPolicyClient.js";
import { loadNativeGitRootImporterConnection } from "../../../../packages/host/plugins/native-git/src/nativeGitRootImporterConnection.js";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { managedProjectFixture } from "./nativeProjectIntegrationFixture.js";
import {
  cleanupFinalizeFixtures,
  activateFinalizeServiceForGeneration,
  activationTokenB,
  closeFinalizeService,
  generationId,
  generationB,
  startFinalizeServiceForGeneration,
  wrongHostRootReadIssuer
} from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("discovers and attaches an authority Project on independent host state without registrar, importer, or reviewer roles", async () => {
  // Given
  const fixture = await managedProjectFixture();
  roots.push(fixture.root);
  await fixture.importRepository("public");
  await fixture.importRepository("private");
  await fixture.store.configure("acme", {
    configurationRepositoryId: "private",
    defaultWorkingRepositoryId: "public"
  }, fixture.connection, AbortSignal.timeout(5_000));
  const attachedState = join(fixture.root, "attached-host");
  await mkdir(attachedState, { mode: 0o700 });
  await new NativeProjectPendingStore(attachedState).create({
    name: "retained",
    projectId: "retained-project",
    ownerHostId: fixture.connection.hostId
  });
  const retainedFile = join(attachedState, "projects/retained.json");
  const retainedBefore = await readFile(retainedFile);
  const environment = {
    ...process.env,
    DIM_MANAGED_STATE_ROOT: attachedState,
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: fixture.hostFile,
    DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: undefined
  };
  const authorityBefore = await readFile(join(fixture.serviceRoot, "native-idle.sqlite3"));

  // When
  const description = await describeNativeProjectConsole(environment, generationId);
  const controller = await createNativeProjectConsole(environment, generationId);
  const discovered = await controller.invoke("projects.discover", {});
  const inspected = await controller.invoke("projects.inspect", { projectId: "project-a" });
  const attached = await controller.invoke("projects.attach", {
    projectId: "project-a",
    name: "shared-acme",
    configurationRepositoryId: "private",
    defaultWorkingRepositoryId: "public"
  });

  // Then
  expect(description).not.toHaveProperty("reviewerId");
  expect(description.projects).toEqual([{ projectId: "retained-project", name: "retained", repositoryIds: [], repositories: [] }]);
  expect(description.operations.map(({ name }) => name)).toEqual(["projects.discover", "projects.inspect", "projects.attach"]);
  expect(discovered).toEqual({ projects: [{ projectId: "project-a", repositoryCount: 2 }] });
  expect(inspected).toEqual({ projectId: "project-a", repositories: [
    { repositoryId: "private", defaultRef: "refs/heads/main", branches: ["refs/heads/development", "refs/heads/main"] },
    { repositoryId: "public", defaultRef: "refs/heads/main", branches: ["refs/heads/development", "refs/heads/main"] }
  ] });
  expect(attached).toEqual({ projectId: "project-a", repositoryCount: 2 });
  const recordFile = join(attachedState, "projects/shared-acme.json");
  const original = await readFile(recordFile);
  expect(JSON.parse(original.toString("utf8"))).toMatchObject({
    schemaVersion: 7,
    phase: "ready",
    name: "shared-acme",
    projectId: "project-a",
    ownerHostId: fixture.connection.hostId,
    configurationRepositoryId: "private",
    defaultWorkingRepositoryId: "public",
    repositories: {
      private: { commit: expect.any(String), tree: expect.any(String), importReceipt: { generationId } },
      public: { commit: expect.any(String), tree: expect.any(String), importReceipt: { generationId } }
    }
  });
  const stagingFile = join(attachedState, `projects/.shared-acme.json.${randomUUID()}.tmp`);
  await link(recordFile, stagingFile);
  expect(await controller.invoke("projects.attach", {
    projectId: "project-a",
    name: "shared-acme",
    configurationRepositoryId: "private",
    defaultWorkingRepositoryId: "public"
  })).toEqual(attached);
  expect(await readFile(recordFile)).toEqual(original);
  expect((await readdir(join(attachedState, "projects"))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  expect(await readFile(join(fixture.serviceRoot, "native-idle.sqlite3"))).toEqual(authorityBefore);
  await fixture.importRepository("later");
  await expect(controller.invoke("projects.attach", {
    projectId: "project-a",
    name: "shared-acme",
    configurationRepositoryId: "private",
    defaultWorkingRepositoryId: "public"
  })).rejects.toThrow("conflicts with existing local state");
  expect(await readFile(recordFile)).toEqual(original);
  expect(await readFile(retainedFile)).toEqual(retainedBefore);
});

it("proves every authoritative repository before publishing any local attachment record", async () => {
  // Given
  const fixture = await managedProjectFixture();
  roots.push(fixture.root);
  await fixture.importRepository("public");
  const deniedHostFile = join(fixture.root, "denied-host.json");
  await writeFile(deniedHostFile, JSON.stringify({
    ...fixture.connection,
    nativeGit: {
      ...fixture.connection.nativeGit,
      workspaceWriteIssuer: {
        ...fixture.connection.nativeGit.workspaceWriteIssuer,
        password: Buffer.alloc(32, 99).toString("base64url")
      }
    }
  }), { mode: 0o600 });
  const deniedState = join(fixture.root, "denied-state");
  await mkdir(deniedState, { mode: 0o700 });
  const controller = await createNativeProjectConsole({
    ...process.env,
    DIM_MANAGED_STATE_ROOT: deniedState,
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: deniedHostFile,
    DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: undefined
  }, generationId);

  // When / Then
  await expect(controller.invoke("projects.attach", {
    projectId: "project-a",
    configurationRepositoryId: "public",
    defaultWorkingRepositoryId: "public"
  })).rejects.toThrow();
  await expect(readFile(join(deniedState, "projects/project-a.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("attaches the current effective policy while preserving the historical import policy and receipt generation", async () => {
  // Given
  const fixture = await managedProjectFixture();
  roots.push(fixture.root);
  await fixture.importRepository("public");
  const original = (await fixture.store.read("acme", fixture.connection.hostId))?.repositories.public;
  if (!original) throw new Error("fixture repository is unavailable");
  const extensions = {
    ...original.repositoryPolicy.extensions,
    "code-review": { requiredReviewerIds: [], pathReviewerRules: [] }
  };
  const policyInput = {
    protectedRef: original.repositoryPolicy.protectedRef,
    extensions,
    ...(original.repositoryPolicy.defaultRef === undefined ? {} : { defaultRef: original.repositoryPolicy.defaultRef }),
    ...(original.repositoryPolicy.branches === undefined ? {} : { branches: original.repositoryPolicy.branches })
  };
  const effectivePolicy = {
    schemaVersion: 1 as const,
    ...policyInput,
    policyRevision: nativeRepositoryPolicyRevision(policyInput)
  };
  const policyClient = createNativeRepositoryPolicyClient(
    await loadNativeGitRootImporterConnection(fixture.importerConnectionFile),
    fixture.connection
  );
  const before = await policyClient.read("project-a", "public", AbortSignal.timeout(5_000));
  await policyClient.update(before, effectivePolicy, AbortSignal.timeout(5_000));
  await closeFinalizeService(fixture.service);
  const current = await startFinalizeServiceForGeneration(fixture.serviceRoot, generationB, activationTokenB);
  await activateFinalizeServiceForGeneration(current.origin, generationB, activationTokenB);
  const currentHostFile = join(fixture.root, "generation-b-host.json");
  await writeFile(currentHostFile, JSON.stringify({
    ...fixture.connection,
    nativeGit: {
      ...fixture.connection.nativeGit,
      endpoint: current.origin,
      generationId: generationB
    }
  }), { mode: 0o600 });
  const attachedState = join(fixture.root, "generation-b-attached");
  await mkdir(attachedState, { mode: 0o700 });

  // When
  const controller = await createNativeProjectConsole({
    ...process.env,
    DIM_MANAGED_STATE_ROOT: attachedState,
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: currentHostFile,
    DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: undefined
  }, generationB);
  await controller.invoke("projects.attach", {
    projectId: "project-a",
    configurationRepositoryId: "public",
    defaultWorkingRepositoryId: "public"
  });

  // Then
  const attached = await new NativeProjectPendingStore(attachedState).read("project-a", fixture.connection.hostId);
  expect(attached?.repositories.public).toMatchObject({
    importReceipt: { generationId },
    repositoryPolicy: { policyRevision: effectivePolicy.policyRevision },
    importedPolicy: { policyRevision: original.repositoryPolicy.policyRevision }
  });
});

it("exposes discover and create-only attach through the CLI and rejects changed defaults without altering the record", async () => {
  // Given
  const fixture = await managedProjectFixture();
  roots.push(fixture.root);
  await fixture.importRepository("public");
  const attachedState = join(fixture.root, "cli-host");
  await mkdir(attachedState, { mode: 0o700 });
  vi.stubEnv("DIM_MANAGED_STATE_ROOT", attachedState);
  vi.stubEnv("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", fixture.hostFile);
  vi.stubEnv("DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE", "");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});

  // When
  await runNativeGitCli(["project", "discover", "--json"]);
  const discovered = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  await runNativeGitCli(["project", "attach", "project-a", "--name", "remote-acme",
    "--configuration-repository", "public", "--default-repository", "public", "--json"]);
  const recordFile = join(attachedState, "projects/remote-acme.json");
  const original = await readFile(recordFile);

  // Then
  expect(discovered).toEqual({ projects: [{ projectId: "project-a", repositoryCount: 1 }] });
  await expect(runNativeGitCli(["project", "attach", "project-a", "--name", "remote-acme",
    "--configuration-repository", "public", "--default-repository", "missing", "--json"])).rejects.toThrow();
  expect(await readFile(recordFile)).toEqual(original);
});

it("keeps foreign host authority isolated during discovery", async () => {
  // Given
  const fixture = await managedProjectFixture();
  roots.push(fixture.root);
  await fixture.importRepository("public");
  const foreignFile = join(fixture.root, "foreign-host.json");
  await writeFile(foreignFile, JSON.stringify({
    ...fixture.connection,
    hostId: wrongHostRootReadIssuer.hostId,
    nativeGit: {
      ...fixture.connection.nativeGit,
      rootReadIssuer: {
        username: wrongHostRootReadIssuer.username,
        password: wrongHostRootReadIssuer.password
      }
    }
  }), { mode: 0o600 });

  // When
  const controller = await createNativeProjectConsole({
    ...process.env,
    DIM_MANAGED_STATE_ROOT: join(fixture.root, "foreign-state"),
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: foreignFile,
    DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: undefined
  }, generationId);

  // Then
  expect(await controller.invoke("projects.discover", {})).toEqual({ projects: [] });
  await expect(controller.invoke("projects.inspect", { projectId: "project-a" })).rejects.toThrow();
});
