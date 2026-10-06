import assert from "node:assert/strict";
import { chmod, chown, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDenialEvidence, captureDenialEvidence } from "./control-plane-install-live-evidence.mjs";
import { runFacade } from "./control-plane-install-live-support.mjs";

export async function runPredecessorPreflight(context) {
  const projectRoot = join(context.lifecycleStateRoot, "ci-runners", "project");
  const recordPath = join(projectRoot, "capacity.json");
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await chmod(join(context.lifecycleStateRoot, "ci-runners"), 0o700);
  await chmod(projectRoot, 0o700);

  await runDenial(context, "obsolete-selector-empty", "", /DIM_ORDINARY_CI_POOL_CONNECTION_FILE/, {
    environment: { ...context.facadeInput.environment, DIM_ORDINARY_CI_POOL_CONNECTION_FILE: "" }
  });
  await writePrivate(recordPath, record("sysbox"));
  await runDenial(context, "schema8-sysbox", recordPath, /Sysbox CI runner state/);
  await writePrivate(recordPath, Buffer.from("{not-json\n"));
  await runDenial(context, "malformed-runner", recordPath, /not valid JSON/);
  await writePrivate(recordPath, record("qemu", 7));
  await runDenial(context, "unsupported-runner", recordPath, /malformed, unsupported/);

  const external = join(context.lifecycleStateRoot, "external-runner.json");
  await writePrivate(external, record("qemu"));
  await rm(recordPath);
  await symlink(external, recordPath);
  await runDenial(context, "symlinked-runner", external, /symbolic link/);
  await rm(recordPath);
  await rm(external);

  await writePrivate(recordPath, record("qemu"));
  await chown(recordPath, 65534, 65534);
  try {
    await runDenial(context, "foreign-owned-runner", recordPath, /invalid ownership/);
  } finally {
    await chown(recordPath, process.getuid(), process.getgid());
  }

  await writePrivate(recordPath, record("qemu"));
  const qemuBytes = await readFile(recordPath);
  console.log(`predecessor-preflight qemu-record=${recordPath} bytes=${qemuBytes.length} preserved=pending`);
  return { recordPath, qemuBytes };
}

export async function assertQemuPredecessorPreserved(input) {
  assert.deepEqual(await readFile(input.recordPath), input.qemuBytes);
  console.log(`predecessor-preflight qemu-record=${input.recordPath} bytes=${input.qemuBytes.length} preserved=true`);
}

async function runDenial(context, name, preservedPath, error, overrides = {}) {
  const before = await captureDenialEvidence(context);
  const preserved = preservedPath === "" ? undefined : await readFile(preservedPath);
  const result = await runFacade({ ...context.facadeInput, ...overrides });
  assert.equal(result.exitCode, 1, `${name} stderr: ${result.stderr}`);
  assert.match(result.stderr, error);
  const after = await captureDenialEvidence(context);
  assertDenialEvidence(name, result.exitCode, before, after);
  if (preserved !== undefined) assert.deepEqual(await readFile(preservedPath), preserved);
}

async function writePrivate(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

function record(kind, schemaVersion = 8) {
  const common = {
    schemaVersion, name: "capacity", projectId: "project-id", projectName: "project", provider: "pending",
    config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
    createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z"
  };
  const executor = kind === "sysbox"
    ? {
        kind, phase: "stopped", containerName: "dim-runner", volumeName: "dim-runner-data",
        image: "example.invalid/runner@sha256:abc", runtime: "sysbox-runc",
        resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: false,
        labels: ["candidate-controlled"], updatedAt: common.updatedAt
      }
    : {
        kind, phase: "ready", supervisorName: "dim-qemu", volumeName: "dim-qemu-data",
        image: "example.invalid/supervisor@sha256:def", jobImage: "example.invalid/job@sha256:123",
        projectHook: { sourceRef: "refs/heads/main", sourceCommit: "c".repeat(40), kind: "present", digest: "d".repeat(64) },
        resources: { cpus: "4", memory: "8g" }, inheritsResources: false,
        labels: ["candidate-controlled"], updatedAt: common.updatedAt
      };
  return Buffer.from(`${JSON.stringify({ ...common, executor }, null, 2)}\n`);
}
