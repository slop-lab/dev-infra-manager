import { parseNativeGitBundleConfig } from "../../../packages/control-plane/plugins/git-repositories/src/bundle-config.js";
import { createServer } from "node:net";
import { startControlPlanePlugins } from "../../../packages/control-plane/core/src/runtime.js";
import type { ControlPlanePlugin } from "../../../packages/control-plane/core/src/plugin-api.js";
import { separatedControlPlanePackages } from "../../../scripts/examples/separated-recipes.ts";
import { prepareSeparatedControlPlane } from "../../../scripts/examples/prepare-separated.ts";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { realGitVersion } from "../../control-plane/plugins/git-repositories/realGitIdentity.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { prepareControlPlane, connectControlPlane } from "../../../packages/control-plane/admin/src/controlPlaneSetup.js";
import { parseControlPlaneServicePair } from "../../../packages/control-plane/admin/src/service-pair.js";
import { executionServiceConfigSchema } from "@slop-lab/dim-control-plane-plugin-execution-scheduler/config";
import { gitCiConfigSchema } from "../../../packages/control-plane/plugins/git-ci/src/config.js";
import { loopbackServiceConfiguration } from "../../../scripts/examples/separated-service-config.ts";
import { separatedControlPlaneConfigurations, selectedSeparatedControlPlaneConfigurations } from "../../../scripts/examples/separated-control-plane-composition.ts";

it("connects with canonical operator documents while placing both services on the CP VM loopback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-separated-config-"));
  try {
    const directory = join(root, "operator");
    await prepareControlPlane({ directory, nativeGitImage: `example/native@sha256:${"a".repeat(64)}`,
      executionImage: `example/ci@sha256:${"b".repeat(64)}` });
    const native: unknown = JSON.parse(await readFile(join(directory, "native-git.json"), "utf8"));
    const ordinary: unknown = JSON.parse(await readFile(join(directory, "execution.json"), "utf8"));
    const prepared = parseControlPlaneServicePair(native, ordinary);
    const projected = separatedControlPlaneConfigurations(prepared.native, ordinary as Record<string, unknown>, { native: {}, ci: {} }, root)
      .find(([name]) => name === "@slop-lab/dim-control-plane-plugin-git-repositories")?.[1] as Record<string, unknown>;
    expect(() => parseNativeGitBundleConfig(projected.service)).not.toThrow();
    expect(prepared.native).toHaveProperty("gitSync");
    const placed = loopbackServiceConfiguration(prepared.native.ci, ordinary);
    const integration = gitCiConfigSchema.parse(placed.gitCi);
    const coordinator = executionServiceConfigSchema.parse(placed.coordinator);
    assert(coordinator.nativeGit && prepared.execution.nativeGit, "prepared CI service requires native Git authority");
    expect(integration.webhook.endpoint).toBe("http://127.0.0.1:8081/v1/jobs");
    expect(coordinator.nativeGit.endpoint).toBe("http://127.0.0.1:8080");
    expect(coordinator.nativeGit.grantIssuer).toEqual(prepared.execution.nativeGit.grantIssuer);
    expect(integration.webhook.password).toBe(prepared.native.ci.webhook.password);
    expect(parseControlPlaneServicePair(native, ordinary)).toEqual(prepared);
    const repositoryRole = prepared.native.workspaceWriteIssuers[0]!;
    expect(() => parseControlPlaneServicePair(native, { ...prepared.execution, credentials: {
      ...prepared.execution.credentials, tasks: { username: repositoryRole.username, password: repositoryRole.password }
    } })).toThrow("credentials must be distinct");
  } finally { await rm(root, { recursive: true, force: true }); }
});


it("starts, activates and normally connects the actual VM recipe control-plane composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-separated-catalog-"));
  try {
    const directory = join(root, "operator");
    await prepareSeparatedControlPlane(directory, prepareControlPlane);
    const native = JSON.parse(await readFile(join(directory, "native-git.json"), "utf8")) as Record<string, unknown>;
    native.gitVersion = realGitVersion;
    const ordinary = JSON.parse(await readFile(join(directory, "execution.json"), "utf8")) as Record<string, unknown>;
    const runtime = JSON.parse(await readFile(join(directory, "acceptance-runtime.json"), "utf8")) as {
      generationId: string; native: { readinessToken: string; activationToken: string }; ci: { readinessToken: string; activationToken: string }
    };
    expect(native).not.toHaveProperty("gitSync");
    expect(native).not.toHaveProperty("webhooks");
    const examples = resolve(import.meta.dirname, "../../../examples");
    const selected = await separatedControlPlanePackages(examples);
    expect(selected.size).toBeGreaterThan(0);
    // Reserve both ports simultaneously so the kernel cannot return one twice.
    const listeners = [createServer(), createServer()];
    await Promise.all(listeners.map((server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done))));
    const ports = listeners.map((server) => { const address = server.address(); assert(address && typeof address !== "string"); return address.port; });
    await Promise.all(listeners.map((server) => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))));
    const [nativePort, ciPort] = ports; assert(nativePort && ciPort);
    const configurations = separatedControlPlaneConfigurations(native, ordinary, runtime, root, { native: nativePort, execution: ciPort });
    const entries = [];
    for (const [name, selectedConfig] of selectedSeparatedControlPlaneConfigurations(configurations, selected)) {
      const owner = resolve(examples, "../packages/control-plane/plugins", name.replace("@slop-lab/dim-control-plane-plugin-", ""));
      const manifest = JSON.parse(await readFile(join(owner, "package.json"), "utf8")) as { name: string; exports: { ".": { "dim-source": { default: string } } } };
      expect(manifest.name).toBe(name);
      const { controlPlanePlugin } = await import(resolve(owner, manifest.exports["."]["dim-source"].default)) as { controlPlanePlugin: ControlPlanePlugin };
      entries.push({ plugin: controlPlanePlugin, config: selectedConfig });
    }
    expect(configurations.map(([name]) => name).sort()).toEqual([...selected].sort());
    expect(() => selectedSeparatedControlPlaneConfigurations(configurations, new Set([...selected, "@slop-lab/dim-control-plane-plugin-git-sync"]))).toThrow("no acceptance configuration");
    const controller = new AbortController();
    const running = await startControlPlanePlugins(entries, controller.signal);
    try {
      for (const [port, role] of [[nativePort, "native"], [ciPort, "ci"]] as const) {
        const base = `http://127.0.0.1:${port}`;
        const activation = { method: "POST", headers: { authorization: `Bearer ${runtime[role].activationToken}`, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, generationId: runtime.generationId }) };
        expect((await fetch(`${base}/v1/activation`, { ...activation, headers: { ...activation.headers, authorization: "Bearer invalid" } })).status).toBe(404);
        const activated = await fetch(`${base}/v1/activation`, activation);
        expect(activated.status).toBe(200);
        expect(await activated.json()).toMatchObject({ generationId: runtime.generationId, activated: true });
        const ready = await fetch(`${base}/readyz`, { headers: { authorization: `Bearer ${runtime[role].readinessToken}` } });
        expect(ready.status).toBe(200);
        expect(await ready.json()).toMatchObject({ status: "ready", schemaVersion: 1 });
      }
      const requestedPaths: string[] = [], client = createNodeNativeGitAdmissionHttpClient();
      const connected = await connectControlPlane(directory, { endpoint: `http://127.0.0.1:${nativePort}`, executionEndpoint: `http://127.0.0.1:${ciPort}`,
        client: { async request(input) { requestedPaths.push(input.path); return client.request(input); } } });
      expect(connected.generationId).toBe(runtime.generationId);
      expect(requestedPaths).not.toContain("/v1/git-sync-operator-identity");
      await expect(readFile(join(connected.directory, "git-sync.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { controller.abort(); await running.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
