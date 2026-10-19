import { cp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessRunner, WorkspaceStore, type WorkspaceRecord, type WorkspaceRuntime, type WorkspaceResources } from "@slop-lab/dim-core/workspace";
import { createManagedWorkspace } from "../../../../core/packages/managed/src/nativeWorkspaceHost.js";
import { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment } from "../../../../core/packages/managed/src/nativeWorkspaceAttachment.js";
import { cleanupFinalizeFixtures } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { managedProjectFixture } from "./nativeProjectIntegrationFixture.js";

vi.mock("../../../../core/packages/managed/src/nativeWorkspaceBrokerProcess.js", () => ({ ensureNativeWorkspaceBroker: vi.fn(async () => {}) }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await cleanupFinalizeFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
class Runtime implements WorkspaceRuntime {
  readonly commands: Array<{ workspace: string; argv: string[] }> = [];
  readonly seeds: string[] = [];
  creates = 0;
  constructor(readonly root: string) {}
  async inspect() { return { running: true }; }
  async create() { this.creates++; }
  async start() {}
  async stop() {}
  async remove() {}
  async updateResources(_record: WorkspaceRecord, _resources: WorkspaceResources) { return { recreated: false }; }
  async seed(record: WorkspaceRecord, directory: string) { const target = path.join(this.root, record.name); await cp(directory, target, { recursive: true }); this.seeds.push(target); }
  async exec(record: WorkspaceRecord, argv: string[]) { this.commands.push({ workspace: record.name, argv }); return 0; }
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
    "http://172.20.0.1:19419/v1/projects/project-a/repositories/public.git", "http://172.20.0.1:19419/v1/projects/project-a/repositories/private.git"]);
  await createManagedWorkspace({ name: "second", source: { url: "dim://acme" }, repositories: ["private"] }, fixture.context);
  expect(fixture.runtime.seed).toBe(originalSeed);
  expect(fixture.runtime.commands.filter(({ workspace }) => workspace === "second")).toHaveLength(4);
  expect(fixture.runtime.seeds).toHaveLength(2);
});
it("rejects invalid repository selections before creating a runtime", async () => {
  const fixture = await workspaceFixture();
  for (const selection of [{ repositories: [] }, { repositories: ["public", "public"] }, { repositories: ["unselected"] }, { repositories: ["public"], workingDirectory: "private" }]) {
    await expect(createManagedWorkspace({ name: "invalid", source: { url: "dim://acme" }, ...selection }, fixture.context)).rejects.toThrow();
  }
  expect(fixture.runtime.creates).toBe(0);
});
