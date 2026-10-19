import { repositoryBinding } from "./nativeProjectFixture.js";
import { executionWorkerConfigSchema } from "../../../../core/packages/managed/src/ci/workerConfig.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
import { createNativeWorkspaceBroker } from "../../../../core/packages/managed/src/nativeWorkspaceBroker.js";
import { refreshNativeWorkspaceConnection } from "../../../../core/packages/managed/src/nativeWorkspaceConnection.js";
import { writeNativeWorkspaceAttachment, readNativeWorkspaceAttachment, nativeWorkspaceAttachmentFile, type NativeWorkspaceAttachment } from "../../../../core/packages/managed/src/nativeWorkspaceAttachment.js";
import { createRequire } from "node:module";
const { Command } = createRequire(new URL("../../../../core/packages/managed/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof registerControlPlaneCommands>[0] };
import { registerControlPlaneCommands } from "../../../../core/packages/managed/src/cli/control-plane-commands.js";
import { saveControlPlaneSelection, selectedControlPlaneHostFile, selectedControlPlaneImporterFile } from "../../../../core/packages/managed/src/controlPlaneSelection.js";
import { dimWorkflowCompiler } from "@slop-lab/dim-plugin-control-plane-ci-workflows";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-plugin-control-plane-native-git/service";
import { parseNativeGitBundleConfig } from "@slop-lab/dim-plugin-control-plane-native-git/config";
import { prepareControlPlane, connectControlPlane } from "../../../../core/packages/managed/src/controlPlaneSetup.js";
import { readControlPlaneConfig } from "../../../../packages/installer/src/controlPlaneConfig.js";
import { readControlPlaneSources } from "../../../../packages/installer/src/controlPlaneSources.js";
import { loadNativeControlPlaneConnection } from "../../../../core/packages/managed/src/nativeControlPlaneConnection.js";
import { createNodeNativeGitRootImporterClient } from "../../../../core/packages/managed/src/nativeGitRootImporterClient.js";
import { bootstrapNativeProjectRepository } from "../../../../core/packages/managed/src/nativeProjectBootstrap.js";
import { NativeProjectPendingStore } from "../../../../core/packages/managed/src/nativeProjectPendingStore.js";
import { loadNativeGitProjectRegistrarConnection } from "../../../../core/packages/managed/src/nativeGitProjectRegistrarConnection.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) {
    execFileSync("/usr/bin/chmod", ["-R", "u+rwX", directory]);
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(options: Partial<Parameters<typeof prepareControlPlane>[0]> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-control-plane-setup-")); roots.push(root);
  const directory = path.join(root, "operator");
  const result = await prepareControlPlane({ directory, nativeGitImage: `registry.example/native@sha256:${"a".repeat(64)}`,
    ordinaryCiImage: `registry.example/ordinary@sha256:${"b".repeat(64)}`, ...options });
  return { root, directory, result };
}

describe("optional control-plane setup", () => {
  it("creates installer-valid private service sources without allocating a worker or exposing role secrets", async () => {
    const { directory, result } = await fixture();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const config = await readControlPlaneConfig(result.configFile, ["127.0.0.1"]);
    const sources = await readControlPlaneSources(config);
    expect(JSON.parse(sources.ordinaryCi.config.bytes.toString()).workers).toEqual([]);
    expect(JSON.parse(sources.nativeGit.config.bytes.toString()).projectRegistrars).toHaveLength(1);
    for (const file of ["install.json", "native-git.json", "ordinary-ci.json", "native-git-readiness.token", "ordinary-ci-readiness.token"]) {
      expect((await stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
    }
    expect(sources.credentialValues.every((secret) => !JSON.stringify(result).includes(secret))).toBe(true);
    await expect(prepareControlPlane({ directory, nativeGitImage: config.nativeGit.image, ordinaryCiImage: config.ordinaryCi.image }))
      .rejects.toThrow(/refusing to replace/);
  });

  it("binds generated bootstrap and host connections to a real native service generation", async () => {
    const profile = { runnerBaseImage: `registry.example/qemu@sha256:${"e".repeat(64)}`,
      jobBaseImage: `registry.example/job@sha256:${"f".repeat(64)}`,
      bounds: { cpu: "1", memoryBytes: "2147483648", pids: "512", wallClockSeconds: "900", outputBytes: "1048576" } };
    const { root, directory } = await fixture({ ciWorker: "worker-1", ciContainerSlots: 1, ciVmSlots: 1,
      ciRunnerImage: `registry.example/sysbox@sha256:${"e".repeat(64)}`, ciJobImage: profile.jobBaseImage, ciVmProfile: profile });
    const ordinary = JSON.parse(await readFile(path.join(directory, "ordinary-ci.json"), "utf8"));
    const native = JSON.parse(await readFile(path.join(directory, "native-git.json"), "utf8"));
    native.gitVersion = execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim().split(" ").at(-1);
    let service = await configuredNativeGitBundleServer({ workflowCompiler: dimWorkflowCompiler,
      config: parseNativeGitBundleConfig(native), stateDirectory: path.join(root, "native-state"),
      readinessToken: Buffer.alloc(32, 47).toString("base64url"), activationToken: Buffer.alloc(32, 48).toString("base64url"),
      expectedGenerationId: "c".repeat(64) });
    try {
      const endpoint = await service.listen("127.0.0.1", 0);
      const connected = await connectControlPlane(directory, { endpoint });
      expect(connected.generationId).toBe("c".repeat(64));
      expect(connected.workerConfigFile).toBe(path.join(connected.directory, "worker.json"));
      const worker = executionWorkerConfigSchema.parse(JSON.parse(await readFile(connected.workerConfigFile!, "utf8")));
      expect(worker).toMatchObject({ workerId: "worker-1", token: ordinary.workers[0].token,
        generationId: connected.generationId, nativeGitEndpoint: endpoint,
        stateDirectory: path.join(directory, "worker-state"),
        slots: [{ id: "container-1", runtime: "container" }, { id: "vm-1", runtime: "vm" }] });
      expect(ordinary.workers[0].slots.map(({ id, runtime }: { id: string; runtime: string }) => ({ id, runtime }))).toEqual(worker.slots);
      expect((await stat(connected.workerConfigFile!)).mode & 0o777).toBe(0o600);
      const selectedState = path.join(root, "selected-host-state");
      vi.stubEnv("DIM_MANAGED_STATE_ROOT", selectedState);
      vi.stubEnv("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", undefined);
      vi.stubEnv("DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE", undefined);
      const output = path.join(root, "cli-connections");
      const printed = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = new Command(); registerControlPlaneCommands(program);
      await program.parseAsync(["control-plane", "connect", directory, "--endpoint", endpoint,
        "--output-directory", output, "--ci-endpoint", "http://127.0.0.1:1",
        "--ci-worker-state-directory", path.join(root, "worker-host", "state")], { from: "user" });
      expect(await selectedControlPlaneHostFile()).toBe(path.join(output, "host.json"));
      expect(await selectedControlPlaneImporterFile()).toBe(path.join(output, "importer.json"));
      expect(JSON.parse(await readFile(path.join(output, "ci-query.json"), "utf8"))).toMatchObject({ role: "query",
        endpoint: "http://127.0.0.1:1", generationId: connected.generationId });
      expect((await stat(path.join(output, "ci-query.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(selectedState, "active-control-plane.json"))).mode & 0o777).toBe(0o600);
      expect(printed.mock.calls.flat().join("\n")).toContain("Selected this control plane");
      expect(printed.mock.calls.flat().join("\n")).toContain(`dim managed ci worker '${path.join(output, "worker.json")}'`);
      expect(printed.mock.calls.flat().join("\n")).not.toContain(worker.token);
      expect(JSON.parse(await readFile(path.join(output, "worker.json"), "utf8")))
        .toMatchObject({ stateDirectory: path.join(root, "worker-host", "state"), endpoint: "http://127.0.0.1:1" });
      printed.mockRestore();
      const host = await loadNativeControlPlaneConnection(path.join(connected.directory, "host.json"));
      expect(host).toMatchObject({ hostId: "operator", nativeGit: { endpoint, generationId: "c".repeat(64) } });
      const reviewer = JSON.parse(await readFile(path.join(connected.directory, "reviewer.json"), "utf8"));
      expect(reviewer).toMatchObject({ schemaVersion: 1, serviceId: "native-main", baseUrl: endpoint,
        reviewerId: "owner", username: "reviewer-owner", generationId: connected.generationId });
      expect((await stat(path.join(connected.directory, "reviewer.json"))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path.join(connected.directory, "promoter.json"), "utf8")))
        .toMatchObject({ role: "host-promoter", hostId: "operator", generationId: connected.generationId });
      expect(await loadNativeGitProjectRegistrarConnection(path.join(connected.directory, "registrar.json"))).toMatchObject({ hostId: "operator", endpoint });
      await (await createNodeNativeGitRootImporterClient(path.join(connected.directory, "importer.json"))).attest(AbortSignal.timeout(5000));
      const activation = await fetch(`${endpoint}/v1/activation`, { method: "POST",
        headers: { authorization: `Bearer ${Buffer.alloc(32, 48).toString("base64url")}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, generationId: connected.generationId }) });
      expect(activation.status).toBe(200);
      const source = path.join(root, "source");
      execFileSync("/usr/bin/git", ["init", "--initial-branch=main", source]);
      await writeFile(path.join(source, "README.md"), "first managed Project\n");
      execFileSync("/usr/bin/git", ["-C", source, "add", "."]);
      execFileSync("/usr/bin/git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
      const hostState = path.join(root, "host-state");
      await mkdir(hostState, { mode: 0o700 });
      const store = new NativeProjectPendingStore(hostState);
      await store.create({ name: "example", projectId: "example", ownerHostId: host.hostId });
      const draft = await bootstrapNativeProjectRepository({ repositoryId: "root", name: "example", projectId: "example", stateRoot: hostState,
        scratchRoot: hostState, sourceRepository: source, gitExecutable: "/usr/bin/git", selectedRef: "refs/heads/main",
        registrarConnectionFile: path.join(connected.directory, "registrar.json"), importerConnectionFile: path.join(connected.directory, "importer.json"),
        policySource: { kind: "manifest-free", review: { ciRepositoryIds: ["root"], requiredReviewerIds: ["owner"], requiredJobs: [] } },
        signal: AbortSignal.timeout(10000) });
      expect(draft.phase).toBe("repository-imported");
      await store.admitRepository("example", "root", await createNodeNativeGitRootImporterClient(path.join(connected.directory, "importer.json")), host, AbortSignal.timeout(10000));
      expect((await store.configure("example", { configurationRepositoryId: "root", defaultWorkingRepositoryId: "root" }, host, AbortSignal.timeout(10000))).phase).toBe("ready");
      await expect(connectControlPlane(directory, { endpoint })).rejects.toThrow(/refusing to replace/);
      // An already running broker must adopt only a proved credential refresh,
      // preserving its Git grant, proposal namespace and mutable checkout.
      const project = await store.read("example", "operator");
      if (!project || project.phase !== "ready") throw new Error("Project not ready");
      const repository = project.repositories.root;
      if (!repository) throw new Error("repository not ready");
      const binding = repositoryBinding(repository);
      const workspace = workspaceRecord("persistent", { source: { url: "dim://example", ref: repository.protectedRef, commit: repository.commit } });
      const workspaceStore = new WorkspaceStore(path.join(root, "core-workspaces")); await workspaceStore.write(workspace);
      const attachment: NativeWorkspaceAttachment = { schemaVersion: 2, workspaceId: workspace.id, workspaceName: workspace.name,
        configuration: binding, repositories: { root: { ...binding, nativeWorkspaceId: randomBytes(32).toString("base64url"), grant: randomBytes(32).toString("base64url") } },
        projectName: "example", projectId: project.projectId, connectionFile: path.join(connected.directory, "host.json"),
        workspaceStateRoot: workspaceStore.root, managedStateRoot: hostState, gateway: "127.0.0.1", port: 19419 };
      await writeNativeWorkspaceAttachment(attachment);
      const broker = createNativeWorkspaceBroker(attachment);
      await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
      try {
        const address = broker.address(); if (!address || typeof address === "string") throw new Error("missing broker address");
        const brokerUrl = `http://127.0.0.1:${address.port}/v1/projects/example/repositories/root.git/info/refs?service=git-upload-pack`;
        const headers = { authorization: `Basic ${Buffer.from(`dim:${attachment.repositories.root!.grant}`).toString("base64")}` };
        expect((await fetch(brokerUrl, { headers })).status).toBe(200);
        await service.close();
        const nextGeneration = "d".repeat(64);
        const nextActivationToken = Buffer.alloc(32, 49).toString("base64url");
        service = await configuredNativeGitBundleServer({ workflowCompiler: dimWorkflowCompiler,
          config: parseNativeGitBundleConfig(native), stateDirectory: path.join(root, "native-state"),
          readinessToken: Buffer.alloc(32, 47).toString("base64url"), activationToken: nextActivationToken,
          expectedGenerationId: nextGeneration });
        expect(await service.listen("127.0.0.1", Number(new URL(endpoint).port))).toBe(endpoint);
        const reactivated = await fetch(`${endpoint}/v1/activation`, { method: "POST",
          headers: { authorization: `Bearer ${nextActivationToken}`, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, generationId: nextGeneration }) });
        expect(reactivated.status).toBe(200);
        expect((await fetch(brokerUrl, { headers })).status).toBe(502);
        const reconnected = await connectControlPlane(directory, { endpoint, outputDirectory: path.join(root, "reconnected") });
        const environment = { DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: path.join(reconnected.directory, "host.json") };
        const refreshed = await refreshNativeWorkspaceConnection(attachment, AbortSignal.timeout(5000), environment);
        expect(refreshed).toEqual({ ...attachment, connectionFile: environment.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE });
        expect(await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(hostState, workspace.id))).toEqual(refreshed);
        expect((await fetch(brokerUrl, { headers })).status).toBe(200);
        for (const changedScope of [{ projectId: "another" },
          { configuration: { ...attachment.configuration, protectedRef: "refs/heads/other" } },
          { repositories: { ...attachment.repositories, root: { ...attachment.repositories.root!, policyRevision: "b".repeat(64) } } }]) {
          await expect(refreshNativeWorkspaceConnection({ ...attachment, ...changedScope }, AbortSignal.timeout(5000), environment))
            .rejects.toThrow(/cannot reconnect/);
          expect(await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(hostState, workspace.id))).toEqual(refreshed);
        }
        const foreign = path.join(root, "foreign.json");
        const foreignConnection = JSON.parse(await readFile(refreshed.connectionFile, "utf8"));
        foreignConnection.nativeGit.endpoint = "http://127.0.0.1:1";
        await writeFile(foreign, JSON.stringify(foreignConnection), { mode: 0o600 });
        await expect(refreshNativeWorkspaceConnection(refreshed, AbortSignal.timeout(5000), {
          DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: foreign
        })).rejects.toThrow(/another control-plane authority/);
        expect(await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(hostState, workspace.id))).toEqual(refreshed);
        // An ambient switch is a default for new workspaces. It must not block
        // the original workspace, whose broker and credentials remain usable.
        const ambient = { DIM_MANAGED_STATE_ROOT: path.join(root, "selection-state") };
        expect(await refreshNativeWorkspaceConnection(refreshed, AbortSignal.timeout(5000), ambient)).toEqual(refreshed);
        const foreignImporter = path.join(root, "foreign-importer.json");
        const importer = JSON.parse(await readFile(path.join(reconnected.directory, "importer.json"), "utf8"));
        importer.endpoint = foreignConnection.nativeGit.endpoint;
        await writeFile(foreignImporter, JSON.stringify(importer), { mode: 0o600 });
        await saveControlPlaneSelection({ hostConnectionFile: foreign, importerConnectionFile: foreignImporter }, ambient);
        expect(await selectedControlPlaneHostFile(ambient)).toBe(foreign);
        expect(await refreshNativeWorkspaceConnection(refreshed, AbortSignal.timeout(5000), ambient)).toEqual(refreshed);
        expect(await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(hostState, workspace.id))).toEqual(refreshed);
        expect((await fetch(brokerUrl, { headers })).status).toBe(200);
      } finally {
        await new Promise<void>((resolve, reject) => { broker.close((error) => error ? reject(error) : resolve()); broker.closeAllConnections(); });
      }
    } finally { await service.close(); }
  });

  it("prepares common Sysbox capacity through CLI image flags without exposing worker credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dim-ci-prepare-cli-")); roots.push(root);
    const directory = path.join(root, "operator"), program = new Command(); registerControlPlaneCommands(program);
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["control-plane", "prepare", directory,
      "--native-git-image", `registry.example/native@sha256:${"a".repeat(64)}`,
      "--ordinary-ci-image", `registry.example/ordinary@sha256:${"b".repeat(64)}`,
      "--ci-worker", "local-ci", "--ci-container-slots", "2",
      "--ci-runner-image", `registry.example/runner@sha256:${"c".repeat(64)}`,
      "--ci-job-image", `registry.example/job@sha256:${"d".repeat(64)}`], { from: "user" });
    const config = await readControlPlaneConfig(path.join(directory, "install.json"), ["127.0.0.1"]);
    const sources = await readControlPlaneSources(config);
    const ordinary = JSON.parse(sources.ordinaryCi.config.bytes.toString());
    expect(ordinary.workers).toHaveLength(1);
    expect(ordinary.workers[0].slots.map(({ id }: { id: string }) => id)).toEqual(["container-1", "container-2"]);
    expect(ordinary.workers[0].slots[0].profile.bounds).toMatchObject({ cpu: "1", memoryBytes: "2147483648", pids: "512" });
    expect(sources.credentialValues).toContain(ordinary.workers[0].token);
    expect(printed.mock.calls.flat().join("\n")).not.toContain(ordinary.workers[0].token);
    await expect(stat(path.join(directory, "worker.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { ciContainerSlots: 1 }, { ciWorker: "worker" }, { ciWorker: "worker", ciContainerSlots: 1 },
    { ciWorker: "worker", ciVmSlots: 1 }, { ciWorker: "worker", ciContainerSlots: -1 },
    { ciWorker: "worker", ciContainerSlots: 65 }, { ciWorker: "worker", ciContainerSlots: 0.5 },
    { ciWorker: "worker", ciContainerSlots: 1, ciRunnerImage: "runner:latest", ciJobImage: "job:latest" },
    { ciWorker: "worker", ciContainerSlots: 1, ciContainerProfile: {}, ciRunnerImage: "runner:latest" }
  ])("rejects incomplete or unreviewed initial capacity before writing files: %j", async (options) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dim-ci-prepare-reject-")); roots.push(root);
    const directory = path.join(root, "operator");
    await expect(prepareControlPlane({ directory, nativeGitImage: `registry.example/native@sha256:${"a".repeat(64)}`,
      ordinaryCiImage: `registry.example/ordinary@sha256:${"b".repeat(64)}`, ...options })).rejects.toThrow();
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unpinned images and non-loopback credential destinations before mutation or requests", async () => {
    const { root, directory } = await fixture();
    await expect(prepareControlPlane({ directory: path.join(root, "invalid"), nativeGitImage: "native:latest", ordinaryCiImage: "ordinary:latest" }))
      .rejects.toThrow(/sha256/);
    await expect(stat(path.join(root, "invalid"))).rejects.toMatchObject({ code: "ENOENT" });
    const client = { request: async () => { throw new Error("credentials must never be sent"); } };
    await expect(connectControlPlane(directory, { endpoint: "http://remote.example:8787", client })).rejects.toThrow(/invalid/);
    await expect(stat(path.join(directory, "connections"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish client files when a role attests another generation", async () => {
    const { directory } = await fixture();
    const client = { request: async (input: { path: string }) => {
      const role = input.path.slice(4, -9);
      return { statusCode: 200, contentType: "application/json", cacheControl: "no-store", body: Buffer.from(JSON.stringify({
        schemaVersion: 1, serviceId: "native-main", role, hostId: "operator",
        generationId: (role === "operator-workspace-write-issuer" ? "b" : "a").repeat(64)
      })) };
    } };
    await expect(connectControlPlane(directory, { client })).rejects.toThrow(/generation changed/);
    await expect(stat(path.join(directory, "connections"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
