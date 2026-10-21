import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configuredManagedGitFixture } from "../../support/managed-git-service.js";
import { parseManagedGitServiceConfig } from "@slop-lab/dim-control-plane-admin/service-pair";
import { dimWorkflowCompiler } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { prepareControlPlane, connectControlPlane } from "../../../packages/control-plane/admin/src/controlPlaneSetup.js";
import { executionServiceConfigSchema } from "../../../packages/contracts/ci/src/config.js";
import { executionWorkerConfigSchema } from "../../../packages/contracts/ci/src/worker.js";
import { executionWorkerClient } from "../../../packages/host/plugins/ci-worker/src/client.js";
import { configuredExecutionServer } from "../../../packages/control-plane/plugins/ci/src/service.js";

it("connects a prepared private worker to its activated CI generation and rejects foreign credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-worker-setup-"));
  const directory = join(root, "prepared"), generationId = randomBytes(32).toString("hex");
  const activationToken = randomBytes(32).toString("base64url");
  const profile = { runnerBaseImage: `registry.example/runner@sha256:${"c".repeat(64)}`,
    jobBaseImage: `registry.example/job@sha256:${"d".repeat(64)}`,
    bounds: { cpu: "1", memoryBytes: "2147483648", pids: "512", wallClockSeconds: "900", outputBytes: "1048576" } };
  let native: Awaited<ReturnType<typeof configuredManagedGitFixture>> | undefined;
  let ci: ReturnType<typeof configuredExecutionServer> | undefined;
  try {
    await prepareControlPlane({ directory, nativeGitImage: `registry.example/native@sha256:${"a".repeat(64)}`,
      ordinaryCiImage: `registry.example/ci@sha256:${"b".repeat(64)}`, ciWorker: "worker-a",
      ciContainerSlots: 1, ciVmSlots: 1, ciContainerProfile: profile, ciVmProfile: profile });
    const nativeConfig = JSON.parse(await readFile(join(directory, "native-git.json"), "utf8"));
    // The fixture executes the host Git binary; production image pins remain unchanged.
    nativeConfig.gitVersion = execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim().split(" ").at(-1);
    native = await configuredManagedGitFixture({ config: parseManagedGitServiceConfig(nativeConfig),
      workflowCompiler: dimWorkflowCompiler, stateDirectory: join(root, "git-state"),
      readinessToken: randomBytes(32).toString("base64url"), activationToken, expectedGenerationId: generationId });
    const nativeEndpoint = await native.listen("127.0.0.1", 0);
    const config = executionServiceConfigSchema.parse(JSON.parse(await readFile(join(directory, "ordinary-ci.json"), "utf8")));
    ci = configuredExecutionServer({ config, stateDirectory: join(root, "ci-state"),
      readinessToken: randomBytes(32).toString("base64url"), activationToken, expectedGenerationId: generationId });
    await new Promise<void>((resolve) => ci!.server.listen(0, "127.0.0.1", resolve));
    const address = ci.server.address();
    if (address === null || typeof address === "string") throw new Error("CI listener missing");
    const ciEndpoint = `http://127.0.0.1:${address.port}`;
    for (const endpoint of [nativeEndpoint, ciEndpoint]) {
      const activation = await fetch(`${endpoint}/v1/activation`, { method: "POST",
        headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, generationId }) });
      expect(activation.status).toBe(200);
    }
    const connected = await connectControlPlane(directory, { endpoint: nativeEndpoint, ciEndpoint });
    expect(connected.workerConfigFile).toBeDefined();
    const workerFile = connected.workerConfigFile!;
    const worker = executionWorkerConfigSchema.parse(JSON.parse(await readFile(workerFile, "utf8")));
    expect((await stat(workerFile)).mode & 0o777).toBe(0o600);
    expect(worker.generationId).toBe(generationId);
    expect(worker.token).toBe(config.workers[0]!.token);
    const headers = { authorization: `Basic ${Buffer.from(`${worker.workerId}:${worker.token}`).toString("base64")}`,
      "x-dim-generation-id": worker.generationId };
    const registration = await fetch(`${worker.endpoint}/v1/worker`, { headers });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toEqual({ generationId, workerId: worker.workerId,
      slots: config.workers[0]!.slots.map((slot) => {
        assert("runtime" in slot, "CI setup created a generic task slot");
        return { id: slot.id, kind: slot.runtime === "container" ? "ordinary-sysbox" : "qemu", profile: slot.profile };
      }) });
    for (const slot of worker.slots) {
      const client = executionWorkerClient({ ...worker, slotId: slot.id });
      expect(await client.claim(randomUUID())).toBeUndefined();
    }
    const claim = { method: "POST", body: JSON.stringify({ requestId: randomUUID(), slotId: worker.slots[0]!.id }) };
    expect((await fetch(`${worker.endpoint}/v1/claims`, { ...claim, headers: { ...headers,
      authorization: `Basic ${Buffer.from(`${worker.workerId}:${randomBytes(32).toString("base64url")}`).toString("base64")}` } })).status).toBe(401);
    expect((await fetch(`${worker.endpoint}/v1/claims`, { ...claim, headers: { ...headers,
      "x-dim-generation-id": randomBytes(32).toString("hex") } })).status).toBe(409);
    expect(ci.store.list()).toEqual([]);
  } finally {
    await ci?.close(); await native?.close(); await rm(root, { recursive: true, force: true });
  }
});
