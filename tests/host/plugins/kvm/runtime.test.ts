import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, copyFile, chmod, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProcessRunner, WorkspaceService, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { configureKvm, hostPlugin } from "../../../../packages/host/plugins/kvm/src/index.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

const image = process.env.DIM_TEST_KVM_IMAGE, parent = process.env.DIM_TEST_KVM_STATE_PARENT, probe = process.env.DIM_TEST_KVM_PROBE;
it.skipIf(!image || !parent || !probe)("prepares KVM without sudo and retains actual guest KVM access across restart/recreation", async () => {
  if (!image || !parent || !probe) throw new Error("reviewed local image, dev-enabled private fixture parent and static KVM ioctl probe are required");
  const root = await mkdtemp(join(parent, "kvm-runtime-")), runner = new ProcessRunner();
  const original = await lstat("/dev/kvm"), record = workspaceRecord(`kvm-${randomUUID()}`, { initialized: false, image, runtime: "container-kvm" });
  const runtimeFactory = hostPlugin.runtime;
  if (!runtimeFactory) throw new Error("KVM runtime is missing");
  const source = join(root, "checkout"); await mkdir(source);
  await runner.run("git", ["init", source]);
  await copyFile(probe, join(source, "kvm-probe")); await chmod(join(source, "kvm-probe"), 0o755);
  let runtime: Awaited<ReturnType<typeof runtimeFactory.create>> | undefined;
  try {
    const device = await configureKvm(root, runner, image);
    expect(await configureKvm(root, runner, image)).toBe(device);
    runtime = await runtimeFactory.create({ stateRoot: root, runner, cleanupRunner: runner });
    await runtime.create(record); await runtime.start(record); await runtime.seed(record, source);
    record.initialized = true;
    const store = new WorkspaceStore(root);
    const service = new WorkspaceService(store, runtime, async () => { throw new Error("verification cannot acquire source"); });
    const context = { store, service, stateRoot: root, runner, cleanupRunner: runner, signal: AbortSignal.timeout(90_000) };
    const verification = hostPlugin.guest?.operations?.find(({ name }) => name === "verify");
    if (!verification) throw new Error("guest KVM verification is not discoverable");
    for (const phase of ["create", "restart", "recreate"] as const) {
      if (phase === "restart") { await runtime.stop(record); await runtime.start(record); }
      if (phase === "recreate") { await runtime.stop(record); await runtime.remove(record, { keepData: true }); await runtime.create(record); await runtime.start(record); }
      expect(await runtime.exec(record, ["/workspace/kvm-probe"]), phase).toBe(0);
      await store.write(record);
      expect(await hostPlugin.workspaceCapabilities?.(record, context), phase).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "vm-fd-verification", state: "available", access: { kind: "guest-operation", operation: "verify" } })
      ]));
      expect(await verification.handle({}, record, context), phase).toMatchObject({ workspaceId: record.id,
        scope: "workspace-kvm", outcome: "verified", effect: "vm-fd-created-and-closed", kvmApiVersion: 12 });
    }
    const after = await lstat("/dev/kvm");
    expect({ inode: after.ino, mode: after.mode, uid: after.uid, gid: after.gid }).toEqual({ inode: original.ino, mode: original.mode, uid: original.uid, gid: original.gid });
  } finally {
    try { await runtime?.remove(record, { keepData: false }); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}, 90_000);
