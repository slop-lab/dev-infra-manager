import { expect, it, vi } from "vitest";
import { ContainerWorkspaceRuntime, ProcessRunner, WorkspaceService, WorkspaceStore, type HostExecutionRouting, type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/workspace";
import { resolveHostExecutionRouting } from "../../../../packages/cli/src/host-plugins.js";
import { hostPlugin } from "../../../../packages/host/plugins/ci-worker/src/index.js";
import { runCiWorker } from "../../../../packages/host/plugins/ci-worker/src/host.js";
vi.mock("../../../../packages/host/plugins/ci-worker/src/host.js", () => ({ runCiWorker: vi.fn(async () => {}) }));

it("forwards optional host routing into worker execution without provisioning or selecting a concrete provider", async () => {
  const runner = new ProcessRunner(), store = new WorkspaceStore("/tmp/dim-worker-routing-test");
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: store.root, store,
    service: new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected source acquisition"); }),
    signal: new AbortController().signal };
  const route: HostExecutionRouting = { network: "cache-network", blockedHostnames: ["registry-1.docker.io"], dockerDaemonConfig: "{}", jobFiles: [{ target: "/etc/npmrc", contents: "registry=https://cache.example/" }] };
  const executionRouting = () => resolveHostExecutionRouting([{ name: "configured", executionRouting: async () => route }], context);
  await hostPlugin.run!(["ci", "worker", "/private/worker.json"], { ...context, executionRouting });
  const options = vi.mocked(runCiWorker).mock.calls.at(-1)?.[2];
  expect(options?.runner).toBe(runner);
  expect(await options?.routingProvider?.()).toBe(route);
  await hostPlugin.run!(["ci", "worker", "/private/worker.json"], context);
  expect(vi.mocked(runCiWorker).mock.calls.at(-1)?.[2]?.routingProvider).toBeUndefined();
});
