import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { buildWorkspaceImage } from "../../../packages/host/core/src/workspaceImage.js";
import { ContainerWorkspaceRuntime, workspaceRuntimeResources } from "../../../packages/host/core/src/workspace/runtime.js";
import { WorkspaceService } from "../../../packages/host/core/src/workspace/service.js";
import { WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";
import { acquireWorkspaceSource } from "../../../packages/host/core/src/workspace/source.js";
import { ensureWorkspaceAgent } from "../../../packages/host/core/src/application/workspace-agent.js";
import { verifyWorkspaceBootIdentity } from "../../../packages/host/core/src/application/workspace-boot-identity.js";
import type { WorkspaceRecord } from "../../../packages/host/core/src/workspace/models.js";

export async function runRuntimeRecovery(evidence: string): Promise<void> {
  const runner = new ProcessRunner(), id = randomUUID();
  const root = await mkdtemp(join(tmpdir(), "dim-runtime-recovery-"));
  const image = `dim-runtime-recovery:${id}`;
  const name = `recovery-${id.slice(0, 8)}`;
  const store = new WorkspaceStore(join(root, "state")), runtime = new ContainerWorkspaceRuntime(runner);
  const service = new WorkspaceService(store, runtime, acquireWorkspaceSource);
  const results: string[] = [];
  let workspace: WorkspaceRecord | undefined;
  let failure: unknown;
  let imageBuilt = false;
  let cleanupFailure: unknown;
  async function checked(command: string, args: string[], cwd?: string) {
    const result = await runner.run(command, args, { ...(cwd === undefined ? {} : { cwd }), signal: AbortSignal.timeout(180_000) });
    assert.equal(result.exitCode, 0, `${command} ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  }
  async function guest(args: string[]) {
    assert(workspace);
    const result = await runtime.run(workspace, args, { signal: AbortSignal.timeout(60_000) });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  }
  try {
    await buildWorkspaceImage(runner, { ...process.env, DIM_WORKSPACE_IMAGE: image }, { signal: AbortSignal.timeout(900_000) });
    imageBuilt = true;
    const context = { runner, cleanupRunner: runner, store, service, runtime, stateRoot: store.root, signal: AbortSignal.timeout(600_000) };
    const source = join(root, "source"); await mkdir(source);
    await checked("git", ["init", "--initial-branch=main", source]);
    await writeFile(join(source, "tracked.txt"), "committed source\n");
    await checked("git", ["add", "."], source);
    await checked("git", ["-c", "user.name=Recovery", "-c", "user.email=recovery@example.invalid", "commit", "-m", "fixture"], source);
    workspace = await service.create({ name, source: { url: source }, image, resources: { cpuCount: "2", memory: "2g", pidsLimit: "1024" } });
    const original = workspace, resources = workspaceRuntimeResources(original);
    await verifyWorkspaceBootIdentity(workspace, context);
    await guest(["sh", "-c", "printf checkout-dirty > tracked.txt; printf untracked > local.txt; printf home-retained > ~/retained.txt; mkdir -p ~/.config/recovery; printf fixture-private-credential > ~/.config/recovery/credential; chmod 600 ~/.config/recovery/credential; printf temp-retained > /mnt/dim-tmp/retained.txt"]);
    await guest(["sh", "-c", "tar -c /bin/busybox /lib/ld-musl-* | docker import - recovery-retained >/dev/null && docker volume create recovery-data >/dev/null && docker run --rm -v recovery-data:/data recovery-retained /bin/busybox sh -c 'echo nested-retained > /data/value'"]);
    const before = await runtime.inspect(workspace);
    results.push("healthy boot identity and nested Docker execution");

    // This real guest mount fault models unreadable/invalid identity, not the fleet ENOTCONN cause.
    await guest(["sudo", "sh", "-c", "printf invalid-boot-identity > /run/dim-recovery-boot-id; mount --bind /run/dim-recovery-boot-id /proc/sys/kernel/random/boot_id"]);
    await assert.rejects(ensureWorkspaceAgent(workspace, context), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /boot_id.*INVALID_BOOT_ID/);
      assert(error.message.includes(original.id));
      assert.match(error.message, /main sessions, subagents and teams/);
      return true;
    });
    const failed = await store.read(workspace.name);
    assert.equal(failed.phase, "running"); assert.match(failed.error ?? "", /boot_id/);
    await assert.rejects(lstat(join(store.root, "agents", workspace.id, "config.json")), { code: "ENOENT" });
    assert.equal(await guest(["sh", "-c", "test ! -e ~/.config/dim/workspace.json && printf unchanged"]), "unchanged");
    assert.deepEqual(await runtime.inspect(workspace), before);
    assert.equal(await guest(["cat", "local.txt"]), "untracked");
    await writeFile(join(evidence, "diagnostic.txt"), failed.error ?? "", { mode: 0o600 });
    results.push("real guest mount fault rejected before integration preparation without stopping workload");

    await assert.rejects(service.recreate(workspace.name, randomUUID()), /identity/);
    assert.deepEqual(await runtime.inspect(workspace), before);
    // Fixture has no user sessions; explicit exact-UUID recreation is authorized here only.
    workspace = await service.recreate(workspace.name, workspace.id);
    assert.equal(workspace.id, original.id);
    assert.deepEqual(workspaceRuntimeResources(workspace), resources);
    assert.notEqual((await runtime.inspect(workspace))?.id, before?.id);
    const recovered = workspace;
    await ensureWorkspaceAgent(recovered, context);
    assert.equal((await store.read(workspace.name)).error, undefined);
    assert.equal(await guest(["cat", "tracked.txt"]), "checkout-dirty");
    assert.equal(await guest(["cat", "local.txt"]), "untracked");
    assert.equal(await guest(["cat", "/home/dim/retained.txt"]), "home-retained");
    assert.equal(await guest(["cat", "/mnt/dim-tmp/retained.txt"]), "temp-retained");
    assert.equal(await guest(["sh", "-c", "test \"$(stat -c %a ~/.config/recovery/credential)\" = 600 && test \"$(cat ~/.config/recovery/credential)\" = fixture-private-credential && printf retained"]), "retained");
    assert.equal(await guest(["docker", "run", "--rm", "-v", "recovery-data:/data", "recovery-retained", "/bin/busybox", "cat", "/data/value"]), "nested-retained");
    assert.equal(await service.exec(workspace.name, ["true"], { workspaceId: workspace.id, stdin: Readable.from([]) }), 0);
    results.push("exact-UUID keep-data recreation restores identity and retains dirty checkout, home, private credentials, tmp, nested image and volume");
  } catch (error) {
    failure = error;
    await writeFile(join(evidence, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
  }
  finally {
    try {
      for (const owned of await store.list()) {
        assert.equal(owned.name, name); assert.equal(owned.image, image);
        await service.discard(owned.name, owned.id);
      }
      if (imageBuilt) await checked("docker", ["image", "rm", image]);
      results.push("exact owned workspace resources and test image removed");
    } catch (error) {
      cleanupFailure = error;
    } finally {
      await writeFile(join(evidence, "result.json"), JSON.stringify({ schemaVersion: 1, status: failure === undefined && cleanupFailure === undefined ? "PASS" : "FAIL", name, image, workspaceId: workspace?.id,
        checks: results, cleanup: cleanupFailure === undefined ? "complete" : "failed", failure: failure instanceof Error ? failure.message : failure,
        cleanupFailure: cleanupFailure instanceof Error ? cleanupFailure.message : cleanupFailure,
        retainedState: cleanupFailure === undefined ? undefined : root,
        limitation: "Injected invalid boot identity through a real guest bind mount; spontaneous Sysbox/FUSE ENOTCONN root cause is not proven." }, null, 2) + "\n");
      if (cleanupFailure === undefined) await rm(root, { recursive: true, force: true });
    }
  }
  if (failure !== undefined || cleanupFailure !== undefined) throw new AggregateError([failure, cleanupFailure].filter((error) => error !== undefined), "runtime recovery verification failed");
  console.log(JSON.stringify({ status: "PASS", checks: results }));
}
