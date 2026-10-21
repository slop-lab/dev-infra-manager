import { mkdtemp, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareControlPlane } from "../../../packages/control-plane/admin/src/controlPlaneSetup.js";
import { parseControlPlaneServicePair } from "../../../packages/control-plane/admin/src/service-pair.js";
import { executionServiceConfigSchema } from "@slop-lab/dim-contracts-ci/config";
import { gitCiConfigSchema } from "../../../packages/control-plane/plugins/git-ci/src/config.js";
import { loopbackServiceConfiguration } from "../../../scripts/examples/separated-service-config.ts";

it("connects with canonical operator documents while placing both services on the CP VM loopback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-separated-config-"));
  try {
    const directory = join(root, "operator");
    await prepareControlPlane({ directory, nativeGitImage: `example/native@sha256:${"a".repeat(64)}`,
      ordinaryCiImage: `example/ci@sha256:${"b".repeat(64)}` });
    const native: unknown = JSON.parse(await readFile(join(directory, "native-git.json"), "utf8"));
    const ordinary: unknown = JSON.parse(await readFile(join(directory, "ordinary-ci.json"), "utf8"));
    const prepared = parseControlPlaneServicePair(native, ordinary);
    const placed = loopbackServiceConfiguration(prepared.native.ci, ordinary);
    const integration = gitCiConfigSchema.parse(placed.gitCi);
    const coordinator = executionServiceConfigSchema.parse(placed.coordinator);
    assert(coordinator.nativeGit && prepared.ordinary.nativeGit, "prepared CI service requires native Git authority");
    expect(integration.webhook.endpoint).toBe("http://127.0.0.1:8081/v1/jobs");
    expect(coordinator.nativeGit.endpoint).toBe("http://127.0.0.1:8080");
    expect(coordinator.nativeGit.grantIssuer).toEqual(prepared.ordinary.nativeGit.grantIssuer);
    expect(integration.webhook.password).toBe(prepared.native.ci.webhook.password);
    expect(parseControlPlaneServicePair(native, ordinary)).toEqual(prepared);
    const repositoryRole = prepared.native.workspaceWriteIssuers[0]!;
    expect(() => parseControlPlaneServicePair(native, { ...prepared.ordinary, credentials: {
      ...prepared.ordinary.credentials, tasks: { username: repositoryRole.username, password: repositoryRole.password }
    } })).toThrow("credentials must be distinct");
  } finally { await rm(root, { recursive: true, force: true }); }
});
