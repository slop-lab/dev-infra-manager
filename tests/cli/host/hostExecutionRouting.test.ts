import { expect, it, vi } from "vitest";
import { ProcessRunner } from "@slop-lab/dim-host-core/workspace";
import { type HostExecutionRouting } from "@slop-lab/dim-host-core/plugin-api";
import { type WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { resolveHostExecutionRouting } from "../../../packages/cli/core/src/host-plugins.js";

const runner = new ProcessRunner();
const context = { runner, cleanupRunner: runner, stateRoot: "/tmp/dim-routing-test", signal: new AbortController().signal };
const routing: HostExecutionRouting = { network: "bridge", blockedHostnames: ["registry-1.docker.io"], dockerDaemonConfig: '{"registry-mirrors":["https://cache.example"]}' };

it("returns no routing for absent or installed unconfigured providers", async () => {
  const unconfigured = vi.fn(async () => undefined);
  expect(await resolveHostExecutionRouting([], context)).toBeUndefined();
  expect(await resolveHostExecutionRouting([{ name: "unconfigured", executionRouting: unconfigured }, { name: "other" }], context)).toBeUndefined();
  expect(unconfigured).toHaveBeenCalledWith({ ...context, extensions: [] });
});

it("passes configured routing unchanged and rejects ambiguous configured providers", async () => {
  const provider: WorkspaceHostPlugin = { name: "configured", executionRouting: async () => routing };
  expect(await resolveHostExecutionRouting([{ name: "unconfigured", executionRouting: async () => undefined }, provider], context)).toBe(routing);
  await expect(resolveHostExecutionRouting([provider, { ...provider, name: "second" }], context)).rejects.toThrow(/conflicting.*configured.*second/);
});

it("does not hide invalid explicit provider configuration", async () => {
  const invalid: WorkspaceHostPlugin = { name: "invalid", executionRouting: async () => { throw new Error("invalid cache URL catalog"); } };
  await expect(resolveHostExecutionRouting([invalid], context)).rejects.toThrow("invalid cache URL catalog");
});
