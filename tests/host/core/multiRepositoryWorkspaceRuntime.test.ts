import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { ContainerWorkspaceRuntime } from "../../../packages/host/core/src/workspace/runtime.js";
import { WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";
import { WorkspaceService } from "../../../packages/host/core/src/workspace/service.js";
import type { WorkspaceRecord } from "../../../packages/host/core/src/workspace/models.js";
import { bootstrapNativeProjectRepository } from "../../../packages/host/plugins/native-git/src/nativeProjectBootstrap.js";
import { NativeProjectPendingStore } from "../../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js";
import { createNodeNativeGitRootImporterClient } from "../../../packages/host/plugins/native-git/src/nativeGitRootImporterClient.js";
import { loadNativeControlPlaneConnection } from "../../../packages/host/plugins/native-git/src/nativeControlPlaneConnection.js";
import { createManagedWorkspace, ensureManagedWorkspace } from "../../../packages/host/plugins/native-git/src/nativeWorkspaceHost.js";
import { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment } from "../../../packages/host/plugins/native-git/src/nativeWorkspaceAttachment.js";
import { bundleSecrets } from "../../control-plane/plugins/native-git/bundleConfigFixture.js";
import { activateFinalizeService, cleanupFinalizeFixtures, generationId, importer,
  rootReadIssuer, runGit, startFinalizeService, workspaceWriteIssuer } from "../../control-plane/plugins/native-git/nativeRootImportFinalizeFixture.js";

const image = process.env.DIM_NATIVE_MULTI_REPOSITORY_IMAGE;
const example = resolve(import.meta.dirname, "../../../examples/projects/native-multiple-repositories");

describe("disposable multi-repository workspace runtime", () => {
  it.skipIf(!image)("seeds independent Git checkouts and retains selected layout across Sysbox recreation", async () => {
    if (!image) throw new Error("provide an already reviewed local DIM_NATIVE_MULTI_REPOSITORY_IMAGE");
    const root = await mkdtemp(join(tmpdir(), "dim-multi-repository-runtime-"));
    const managed = join(root, "managed"); await mkdir(managed, { mode: 0o700 });
    const runner = new ProcessRunner(), runtime = new ContainerWorkspaceRuntime(runner), store = new WorkspaceStore(join(root, "workspaces"));
    const lifecycle = new WorkspaceService(store, runtime, async () => { throw new Error("recreation must not acquire source"); });
    const names = [`multi-repo-${randomUUID().slice(0, 8)}`, `public-only-${randomUUID().slice(0, 8)}`];
    const previous = { DIM_MANAGED_STATE_ROOT: process.env.DIM_MANAGED_STATE_ROOT,
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE,
      NODE_OPTIONS: process.env.NODE_OPTIONS, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH };
    const checkoutSources = new Map<string, string>();
    let cleanupSafe = true;
    try {
      const inspected = await runner.run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      expect(inspected.stdout.trim()).toMatch(/^sha256:[a-f0-9]{64}$/);
      // Brokers are real source processes. No shared dist rebuild or compiled fallback is required.
      process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS ?? ""} --import=${resolve(import.meta.dirname, "../../../node_modules/tsx/dist/loader.mjs")}`.trim();
      process.env.TSX_TSCONFIG_PATH = resolve(import.meta.dirname, "../../tsconfig.json");
      const service = await startFinalizeService(join(root, "native"));
      await activateFinalizeService(service.origin);
      const connections = join(root, "connections"); await mkdir(connections, { mode: 0o700 });
      const hostFile = join(connections, "host.json"), registrarFile = join(connections, "registrar.json"), importerFile = join(connections, "importer.json");
      await writeFile(hostFile, JSON.stringify({ schemaVersion: 1, hostId: importer.hostId,
        nativeGit: { transport: "loopback-http", endpoint: service.origin, serviceId: "native-main", generationId,
          workspaceWriteIssuer: { username: workspaceWriteIssuer.username, password: workspaceWriteIssuer.password },
          rootReadIssuer: { username: rootReadIssuer.username, password: rootReadIssuer.password } } }), { mode: 0o600 });
      await writeFile(registrarFile, JSON.stringify({ schemaVersion: 1, endpoint: service.origin, serviceId: "native-main", hostId: importer.hostId,
        generationId, credential: { username: "registrar-a", password: bundleSecrets.projectRegistrar } }), { mode: 0o600 });
      await writeFile(importerFile, JSON.stringify({ schemaVersion: 1, endpoint: service.origin, serviceId: "native-main", role: "operator-root-importer",
        hostId: importer.hostId, generationId, credential: { username: importer.username, password: importer.password } }), { mode: 0o600 });
      const connection = await loadNativeControlPlaneConnection(hostFile), projects = new NativeProjectPendingStore(managed);
      await projects.create({ name: "example", projectId: "example", ownerHostId: importer.hostId });
      const importerClient = await createNodeNativeGitRootImporterClient(importerFile);
      for (const repositoryId of ["public", "private"]) {
        const source = join(root, `source-${repositoryId}`); checkoutSources.set(repositoryId, source);
        await cp(join(example, repositoryId), source, { recursive: true });
        await runGit("/usr/bin/git", ["init", "--initial-branch=main", source]);
        const policy: unknown = JSON.parse(await readFile(join(example, "policies", `${repositoryId}.json`), "utf8"));
        if (typeof policy !== "object" || policy === null || !("review" in policy) || !("repositoryId" in policy)
          || policy.repositoryId !== repositoryId) throw new Error("invalid example policy");
        await runGit("/usr/bin/git", ["-C", source, "add", "."]);
        await runGit("/usr/bin/git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "source"]);
        await bootstrapNativeProjectRepository({ name: "example", projectId: "example", repositoryId, stateRoot: managed, scratchRoot: managed,
          sourceRepository: source, gitExecutable: "/usr/bin/git", selectedRef: "refs/heads/main", registrarConnectionFile: registrarFile,
          importerConnectionFile: importerFile, policySource: { kind: "manifest-free", review: policy.review }, signal: AbortSignal.timeout(30_000) });
        await projects.admitRepository("example", repositoryId, importerClient, connection, AbortSignal.timeout(10_000));
      }
      await projects.configure("example", { configurationRepositoryId: "private", defaultWorkingRepositoryId: "public" }, connection, AbortSignal.timeout(10_000));
      process.env.DIM_MANAGED_STATE_ROOT = managed;
      process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE = hostFile;
      let validatedConfigurations = 0;
      const context = { runner, store, runtime, async validateCheckout(directory: string) {
        expect(await readFile(join(directory, "expected-public-version.txt"), "utf8")).toBe("1\n");
        expect(await readFile(join(directory, ".dim/ci/runner.yml"), "utf8"))
          .toBe(await readFile(join(example, "private/.dim/ci/runner.yml"), "utf8"));
        validatedConfigurations++;
      } };
      const all = await createManagedWorkspace({ name: names[0]!, source: { url: "dim://example" }, repositories: ["public", "private"],
        workingDirectory: "private", image, git: { name: "Workspace Developer", email: "workspace@example.invalid" },
        resources: { cpuCount: "2", memory: "2g", pidsLimit: "1024" } }, context);
      const guest = async (record: WorkspaceRecord, argv: string[]) => {
        const result = await runtime.run(record, argv, { signal: AbortSignal.timeout(60_000) });
        expect(result.exitCode, result.stderr).toBe(0); return result.stdout.trim();
      };
      expect(await guest(all, ["pwd"])).toBe("/workspace/private");
      expect(await guest(all, ["bash", ".dim/ci/jobs/integration.bash"])).toBe("native-multiple-integration-ok");
      const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(managed, all.id));
      expect(attachment.repositories.public?.grant).not.toBe(attachment.repositories.private?.grant);
      expect(attachment.repositories.public?.nativeWorkspaceId).not.toBe(attachment.repositories.private?.nativeWorkspaceId);
      for (const repositoryId of ["public", "private"]) {
        expect(await guest(all, ["git", "-C", `/workspace/${repositoryId}`, "rev-parse", "--show-toplevel"])).toBe(`/workspace/${repositoryId}`);
        expect(await guest(all, ["git", "-C", `/workspace/${repositoryId}`, "config", "--local", "user.name"])).toBe("Workspace Developer");
        expect(await guest(all, ["git", "-C", `/workspace/${repositoryId}`, "config", "--local", "user.email"])).toBe("workspace@example.invalid");
        expect(await guest(all, ["git", "-C", `/workspace/${repositoryId}`, "remote", "get-url", "origin"])).toContain(`/repositories/${repositoryId}.git`);
        await guest(all, ["git", "-C", `/workspace/${repositoryId}`, "fetch", "origin"]);
        await guest(all, ["sh", "-ceu", `cd /workspace/${repositoryId}; printf 'proposal\\n' >> README.md; git add README.md; git commit -m proposal; git push origin`]);
        const expected = await runGit("/usr/bin/git", ["-C", checkoutSources.get(repositoryId)!, "rev-parse", "HEAD"]);
        const protectedHead = await runGit("/usr/bin/git", ["--git-dir", join(root, "native/example", `${repositoryId}.git`), "rev-parse", "refs/heads/main"]);
        expect(protectedHead.stdout.trim()).toBe(expected.stdout.trim());
      }
      await guest(all, ["sh", "-ceu", "printf retained > /workspace/public/untracked; printf private-retained > /workspace/private/untracked"]);
      const recreated = await lifecycle.recreate(all.name, all.id); await ensureManagedWorkspace(recreated, context);
      expect(recreated.id).toBe(all.id); expect(recreated.source).toEqual(all.source);
      expect(await guest(recreated, ["pwd"])).toBe("/workspace/private");
      expect(await guest(recreated, ["cat", "/workspace/public/untracked"])).toBe("retained");
      expect(await guest(recreated, ["cat", "/workspace/private/untracked"])).toBe("private-retained");
      const publicOnly = await createManagedWorkspace({ name: names[1]!, source: { url: "dim://example" }, repositories: ["public"], image,
        resources: { cpuCount: "2", memory: "2g", pidsLimit: "1024" } }, context);
      expect(await guest(publicOnly, ["pwd"])).toBe("/workspace/public");
      expect(await guest(publicOnly, ["sh", "-ceu", "test ! -e /workspace/private; test ! -e /workspace/public/expected-public-version.txt; ls -A /workspace"])).toBe("public");
      expect(await guest(publicOnly, ["bash", ".dim/ci/jobs/source.bash"])).toBe("native-multiple-public-ok");
      expect(validatedConfigurations).toBe(2);
    } finally {
      for (const record of await store.list()) {
        try { await lifecycle.discard(record.name, record.id); }
        catch (error) { cleanupSafe = false; console.error(`preserved owned fixture state at ${root}`, error); }
      }
      await cleanupFinalizeFixtures();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (cleanupSafe) await rm(root, { recursive: true, force: true });
      else throw new Error(`owned workspace cleanup could not be confirmed; fixture preserved at ${root}`);
    }
  }, 300_000);
});
