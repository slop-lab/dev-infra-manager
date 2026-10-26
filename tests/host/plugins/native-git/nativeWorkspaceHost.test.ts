import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner, WorkspaceService, WorkspaceStore, workspaceServiceEndpoint, type WorkspaceRecord, type WorkspaceRuntime, type WorkspaceResources } from "@slop-lab/dim-host-core/workspace";
import { createManagedWorkspace, ensureManagedWorkspace } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceHost.js";
import { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment, writeNativeWorkspaceAttachment } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceAttachment.js";
import { cleanupFinalizeFixtures, generationId } from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { managedProjectFixture } from "./nativeProjectIntegrationFixture.js";
import { createNativeProjectConsole } from "../../../../packages/host/plugins/native-git/src/projectConsole.js";
import { createNativeRepositoryPolicyClient } from "../../../../packages/host/plugins/native-git/src/nativeRepositoryPolicyClient.js";
import { loadNativeGitRootImporterConnection } from "../../../../packages/host/plugins/native-git/src/nativeGitRootImporterConnection.js";
import { NativeProjectPendingStore } from "../../../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { hostPlugin } from "../../../../packages/host/plugins/native-git/src/plugin.js";

vi.mock("../../../../packages/host/plugins/native-git/src/nativeWorkspaceBrokerProcess.js", () => ({ ensureNativeWorkspaceBroker: vi.fn(async () => {}) }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await cleanupFinalizeFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
class Runtime implements WorkspaceRuntime {
  readonly commands: Array<{ workspace: string; argv: string[] }> = [];
  readonly origins = new Map<string, string>();
  readonly seeds: string[] = [];
  creates = 0;
  repairFailureAt: number | undefined;
  private repairAttempts = 0;
  constructor(readonly root: string) {}
  async inspect() { return { running: true }; }
  async create() { this.creates++; }
  async start() {}
  async stop() {}
  async remove() {}
  async updateResources(_record: WorkspaceRecord, _resources: WorkspaceResources) { return { recreated: false }; }
  async seed(record: WorkspaceRecord, directory: string) { const target = path.join(this.root, record.name); await cp(directory, target, { recursive: true }); this.seeds.push(target); }
  async exec(record: WorkspaceRecord, argv: string[]) {
    this.commands.push({ workspace: record.name, argv });
    if (argv[0] === "git" && argv.includes("set-url")) this.origins.set(argv[2]!, argv.at(-1)!);
    if (argv[0] === "node") {
      this.repairAttempts++;
      if (this.repairAttempts === this.repairFailureAt) return 1;
      const [directory, before, after] = argv.slice(-3);
      if (directory !== undefined && before !== undefined && after !== undefined && this.origins.get(directory) === before) this.origins.set(directory, after);
    }
    return 0;
  }
  allowRepairs() { this.repairFailureAt = undefined; this.repairAttempts = 0; }
  async connect(): Promise<number> { throw new Error("unexpected raw connection"); }
  async hostGateway() { return "172.20.0.1"; }
}
async function workspaceFixture() {
  const native = await managedProjectFixture(); roots.push(native.root);
  await native.importRepository("public", "public checkout");
  await native.importRepository("private", "private configuration");
  await native.store.configure("acme", { configurationRepositoryId: "private", defaultWorkingRepositoryId: "public" }, native.connection, AbortSignal.timeout(10_000));
  vi.stubEnv("DIM_MANAGED_STATE_ROOT", native.state);
  vi.stubEnv("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", native.hostFile);
  const runtime = new Runtime(native.root), store = new WorkspaceStore(path.join(native.root, "workspaces"));
  return { ...native, runtime, context: { store, runner: new ProcessRunner(), runtime, signal: AbortSignal.timeout(30_000) } };
}
it("keeps an unselected configuration repository on the host and seeds only the default checkout", async () => {
  const fixture = await workspaceFixture();
  let configuration = "", sourceUrl = "";
  const record = await createManagedWorkspace({ name: "default", source: { url: "dim://acme" } }, { ...fixture.context,
    async validateCheckout(directory, source) { configuration = await readFile(path.join(directory, "README.md"), "utf8"); sourceUrl = source.url; } });
  expect(configuration).toBe("private configuration\n");
  expect(sourceUrl).toBe("dim://acme/private");
  expect(record.source.workingDirectory).toBe("public");
  expect(record.source.checkouts?.map((checkout) => checkout.directory)).toEqual(["public"]);
  expect(await readdir(path.join(fixture.root, "default"))).toEqual(["public"]);
  expect(await readFile(path.join(fixture.root, "default/public/README.md"), "utf8")).toBe("public checkout\n");
  const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(fixture.state, record.id));
  expect(attachment.configuration.repositoryId).toBe("private");
  expect(Object.keys(attachment.repositories)).toEqual(["public"]);
  expect(fixture.runtime.commands.every(({ argv }) => argv[2] === "/workspace/public")).toBe(true);
});
it("seeds selected independent repositories with separate grants and never mutates a reused runtime", async () => {
  const fixture = await workspaceFixture(), originalSeed = fixture.runtime.seed;
  const record = await createManagedWorkspace({ name: "both", source: { url: "dim://acme" }, repositories: ["public", "private"], workingDirectory: "private" }, fixture.context);
  expect(record.source.workingDirectory).toBe("private");
  for (const repository of ["public", "private"]) expect(await readdir(path.join(fixture.root, "both", repository))).toContain(".git");
  const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(fixture.state, record.id));
  expect(attachment.repositories.public?.grant).not.toBe(attachment.repositories.private?.grant);
  expect(fixture.runtime.commands.filter(({ argv }) => argv.includes("set-url")).map(({ argv }) => argv.at(-1))).toEqual([
    `${workspaceServiceEndpoint("native-git")}/v1/projects/project-a/repositories/public.git`,
    `${workspaceServiceEndpoint("native-git")}/v1/projects/project-a/repositories/private.git`]);
  expect(fixture.runtime.commands.filter(({ argv }) => argv.includes("push.default")).map(({ argv }) => argv.at(-1)))
    .toEqual(["current", "current"]);
  expect(fixture.runtime.commands.some(({ argv }) => argv.includes("remote.origin.push"))).toBe(false);
  const configuredCommands = fixture.runtime.commands.length;
  await ensureManagedWorkspace(record, fixture.context);
  expect(fixture.runtime.commands).toHaveLength(configuredCommands + 2);
  await createManagedWorkspace({ name: "second", source: { url: "dim://acme" }, repositories: ["private"] }, fixture.context);
  expect(fixture.runtime.seed).toBe(originalSeed);
  expect(fixture.runtime.commands.filter(({ workspace }) => workspace === "second")).toHaveLength(4);
  expect(fixture.runtime.seeds).toHaveLength(2);
});
it("keeps the previous broker endpoint durable until every owned origin is repaired", async () => {
  const fixture = await workspaceFixture();
  const record = await createManagedWorkspace({ name: "migration", source: { url: "dim://acme" }, repositories: ["public", "private"] }, fixture.context);
  const file = nativeWorkspaceAttachmentFile(fixture.state, record.id);
  const attachment = await readNativeWorkspaceAttachment(file);
  const legacy = { ...attachment, gateway: "172.20.0.1" };
  await writeNativeWorkspaceAttachment(legacy);
  for (const repositoryId of Object.keys(legacy.repositories)) {
    fixture.runtime.origins.set(`/workspace/${repositoryId}`, `http://${legacy.gateway}:${legacy.port}/v1/projects/${legacy.projectId}/repositories/${repositoryId}.git`);
  }
  fixture.runtime.repairFailureAt = 2;

  await expect(ensureManagedWorkspace(record, fixture.context)).rejects.toThrow(/cannot refresh the owned Native Git workspace origin/);

  const failed = await readNativeWorkspaceAttachment(file);
  expect(failed.gateway).toBe(legacy.gateway);
  expect(failed.configuration).toEqual(legacy.configuration);
  expect(failed.repositories).toEqual(legacy.repositories);
  expect(fixture.runtime.origins.get("/workspace/public")).toBe(`${workspaceServiceEndpoint("native-git")}/v1/projects/project-a/repositories/public.git`);
  expect(fixture.runtime.origins.get("/workspace/private")).toBe(`http://${legacy.gateway}:${legacy.port}/v1/projects/project-a/repositories/private.git`);

  fixture.runtime.allowRepairs();
  await ensureManagedWorkspace(record, fixture.context);
  const completed = await readNativeWorkspaceAttachment(file);
  expect(completed.gateway).toMatch(/^127\./);
  expect(completed.configuration).toEqual(legacy.configuration);
  expect(completed.repositories).toEqual(legacy.repositories);
  expect(fixture.runtime.origins.get("/workspace/private")).toBe(`${workspaceServiceEndpoint("native-git")}/v1/projects/project-a/repositories/private.git`);
});
it("preserves a user-modified origin while migrating other owned origins", async () => {
  const fixture = await workspaceFixture();
  const record = await createManagedWorkspace({ name: "custom-origin", source: { url: "dim://acme" }, repositories: ["public", "private"] }, fixture.context);
  const file = nativeWorkspaceAttachmentFile(fixture.state, record.id);
  const attachment = { ...await readNativeWorkspaceAttachment(file), gateway: "172.20.0.1" };
  await writeNativeWorkspaceAttachment(attachment);
  fixture.runtime.origins.set("/workspace/public", `http://${attachment.gateway}:${attachment.port}/v1/projects/${attachment.projectId}/repositories/public.git`);
  fixture.runtime.origins.set("/workspace/private", "ssh://developer@example.invalid/private.git");

  await ensureManagedWorkspace(record, fixture.context);

  expect(fixture.runtime.origins.get("/workspace/public")).toBe(`${workspaceServiceEndpoint("native-git")}/v1/projects/project-a/repositories/public.git`);
  expect(fixture.runtime.origins.get("/workspace/private")).toBe("ssh://developer@example.invalid/private.git");
});
it("advertises only its owned service name and resolves it from fenced attachment state", async () => {
  const fixture = await workspaceFixture();
  const record = await createManagedWorkspace({ name: "service-owner", source: { url: "dim://acme" } }, fixture.context);
  const services = hostPlugin.workspaceServices;
  if (!services) throw new Error("Native Git service ownership is missing");
  const service = new WorkspaceService(fixture.context.store, fixture.runtime, async () => { throw new Error("source acquisition is not expected"); });
  const context = { ...fixture.context, cleanupRunner: fixture.context.runner, stateRoot: fixture.context.store.root, service };

  expect(services.names).toEqual(["native-git"]);
  await expect(services.resolve("other", record, context)).resolves.toBeUndefined();
  await expect(services.resolve("native-git", record, context)).resolves.toMatch(/^http:\/\/127\.[0-9]+\.[0-9]+\.[0-9]+:19419$/);
});
it("advertises scoped Git only to managed Project workspaces without guest operator operations", async () => {
  const fixture = await workspaceFixture();
  const managed = await createManagedWorkspace({ name: "guest-discovery", source: { url: "dim://acme" } }, fixture.context);
  const guest = hostPlugin.guest;
  if (!guest?.inspect) throw new Error("Native Git guest discovery is missing");

  await expect(guest.inspect(managed, {
    ...fixture.context,
    cleanupRunner: fixture.context.runner,
    stateRoot: fixture.context.store.root,
    service: new WorkspaceService(fixture.context.store, fixture.runtime, async () => { throw new Error("source acquisition is not expected"); })
  })).resolves.toEqual({ state: "ready" });
  await expect(guest.inspect({ ...managed, source: { ...managed.source, url: "https://example.invalid/repository.git" } }, {
    ...fixture.context,
    cleanupRunner: fixture.context.runner,
    stateRoot: fixture.context.store.root,
    service: new WorkspaceService(fixture.context.store, fixture.runtime, async () => { throw new Error("source acquisition is not expected"); })
  })).resolves.toMatchObject({ state: "unconfigured" });
  expect(guest.commands).toEqual([
    { name: "git", description: expect.stringContaining("scoped managed repositories") },
    { name: "dim-ci", description: expect.stringContaining("exact-candidate DIM CI") },
  ]);
  expect(guest.operations).toBeUndefined();
});
it("rejects invalid repository selections before creating a runtime", async () => {
  const fixture = await workspaceFixture();
  for (const selection of [{ repositories: [] }, { repositories: ["public", "public"] }, { repositories: ["unselected"] }, { repositories: ["public"], workingDirectory: "private" }]) {
    await expect(createManagedWorkspace({ name: "invalid", source: { url: "dim://acme" }, ...selection }, fixture.context)).rejects.toThrow();
  }
  expect(fixture.runtime.creates).toBe(0);
});
it("keeps default-branch configuration separate from a development working checkout", async () => {
  const fixture = await workspaceFixture();
  await fixture.store.configure("acme", { configurationRepositoryId: "public", defaultWorkingRepositoryId: "public" }, fixture.connection, AbortSignal.timeout(10_000));
  let configurationPath = "", configurationRef = "";
  const record = await createManagedWorkspace({ name: "development", source: { url: "dim://acme", ref: "development" } }, { ...fixture.context,
    async validateCheckout(directory, source) { configurationPath = directory; configurationRef = source.ref ?? ""; }
  });
  expect(configurationRef).toBe("refs/heads/main");
  expect(path.basename(configurationPath)).toBe("checkout");
  expect(record.source.checkouts?.[0]?.source.ref).toBe("refs/heads/development");
  const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(fixture.state, record.id));
  expect(attachment.configuration.protectedRef).toBe("refs/heads/main");
  expect(attachment.repositories.public?.protectedRef).toBe("refs/heads/development");
  expect(fixture.runtime.commands.some(({ argv }) => argv.includes("push.default") && argv.at(-1) === "current")).toBe(true);
});

it("refreshes authority-owned policy on explicit reattach and acquires a dotted and underscored local alias", async () => {
  // Given
  const fixture = await workspaceFixture();
  const attachedState = path.join(fixture.root, "attached-managed");
  await mkdir(attachedState, { mode: 0o700 });
  const environment = {
    ...process.env,
    DIM_MANAGED_STATE_ROOT: attachedState,
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: fixture.hostFile,
    DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: undefined
  };
  const controller = await createNativeProjectConsole(environment, generationId);
  await controller.invoke("projects.attach", {
    projectId: "project-a",
    name: "team.project_one",
    configurationRepositoryId: "private",
    defaultWorkingRepositoryId: "public"
  });
  const attachedStore = new NativeProjectPendingStore(attachedState);
  const before = await attachedStore.read("team.project_one", fixture.connection.hostId);
  const publicRepository = before?.repositories.public;
  if (before?.phase !== "ready" || !publicRepository) throw new Error("attached fixture repository is unavailable");
  const extensions = {
    ...publicRepository.repositoryPolicy.extensions,
    "code-review": { requiredReviewerIds: [], pathReviewerRules: [] }
  };
  const policyInput = {
    protectedRef: publicRepository.repositoryPolicy.protectedRef,
    extensions,
    ...(publicRepository.repositoryPolicy.defaultRef === undefined ? {} : { defaultRef: publicRepository.repositoryPolicy.defaultRef }),
    ...(publicRepository.repositoryPolicy.branches === undefined ? {} : { branches: publicRepository.repositoryPolicy.branches })
  };
  const effectivePolicy = { schemaVersion: 1 as const, ...policyInput, policyRevision: nativeRepositoryPolicyRevision(policyInput) };
  const policyClient = createNativeRepositoryPolicyClient(
    await loadNativeGitRootImporterConnection(fixture.importerConnectionFile),
    fixture.connection
  );
  const authorityPolicy = await policyClient.read("project-a", "public", AbortSignal.timeout(5_000));
  await policyClient.update(authorityPolicy, effectivePolicy, AbortSignal.timeout(5_000));
  await controller.invoke("projects.attach", {
    projectId: "project-a",
    name: "team.project_one",
    configurationRepositoryId: "private",
    defaultWorkingRepositoryId: "public"
  });
  const refreshed = await attachedStore.read("team.project_one", fixture.connection.hostId);
  expect(refreshed).toMatchObject({
    readyAt: before.readyAt,
    configurationRepositoryId: before.configurationRepositoryId,
    defaultWorkingRepositoryId: before.defaultWorkingRepositoryId,
    repositories: {
      public: {
        readyAt: publicRepository.readyAt,
        commit: publicRepository.commit,
        tree: publicRepository.tree,
        importReceipt: publicRepository.importReceipt,
        repositoryPolicy: { policyRevision: effectivePolicy.policyRevision },
        importedPolicy: { policyRevision: publicRepository.repositoryPolicy.policyRevision }
      }
    }
  });
  vi.stubEnv("DIM_MANAGED_STATE_ROOT", attachedState);
  vi.stubEnv("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", fixture.hostFile);
  const runtime = new Runtime(fixture.root);
  const context = {
    store: new WorkspaceStore(path.join(fixture.root, "attached-workspaces")),
    runner: new ProcessRunner(),
    runtime,
    signal: AbortSignal.timeout(30_000)
  };

  // When
  const record = await createManagedWorkspace({
    name: "attached-source",
    source: { url: "dim://team.project_one" }
  }, context);

  // Then
  expect(record.source.workingDirectory).toBe("public");
  expect(await readFile(path.join(fixture.root, "attached-source/public/README.md"), "utf8"))
    .toBe("public checkout\n");
});
