import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CommandResult } from "@slop-lab/dim-host-core";
import { createDimController, registerPlugins } from "@slop-lab/dim-host-core/controller";
import {
  ContainerWorkspaceRuntime,
  WorkspaceStore,
  workspaceRuntimeResources,
  type StreamingCommandRunner,
  type WorkspaceRecord,
  type WorkspaceRuntimeDevice
} from "@slop-lab/dim-host-core/workspace";
import { ControllerWorkspaces } from "../../../../packages/host/core/src/controller/controllerWorkspace.js";
import { createExternalUrlsPlugin } from "../../../../packages/host/plugins/external-urls/src/index.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

const cleanup: Array<() => Promise<void>> = [];
const device: WorkspaceRuntimeDevice = {
  hostPath: "/private/devices/kvm",
  containerPath: "/dev/kvm",
  major: 10,
  minor: 232,
  permissions: "rw"
};

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
});

it("creates an external route through the selected runtime's exact trusted-device grant", async () => {
  // Given: a container-kvm record whose selected runtime owns one exact device grant.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-selected-runtime-route-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const record = workspaceRecord("work", { runtime: "container-kvm" });
  await new WorkspaceStore(stateRoot).write(record);
  const runner = new TrustedDeviceRouteRunner(record);
  const selectedRuntime = new ContainerWorkspaceRuntime(runner, runner, { devices: [device] });
  const authority = new ControllerWorkspaces({ stateRoot, workspaceRuntime: selectedRuntime }, stateRoot);
  const listenPort = await availablePort();
  const registered = await registerPlugins([createExternalUrlsPlugin({ ingresses: {
    shared: {
      description: "selected runtime route",
      scheme: "http",
      domain: "example.test",
      listenHost: "127.0.0.1",
      listenPort
    }
  } })]);
  cleanup.push(() => registered.dispose());
  const workspace = { id: record.id, name: record.name };
  const controller = createDimController({
    stateRoot,
    routes: registered.controllerRoutes,
    authenticate: async () => workspace,
    runWorkspaceRequest: (current, operation) => authority.run(current, operation),
    resolveTarget: (current, target) => authority.resolveTarget(current, target)
  });
  await listen(controller);
  cleanup.push(() => close(controller));

  // When: the workspace creates a real external URL route through the controller API.
  const response = await fetch(`http://127.0.0.1:${port(controller)}/api/urls`, {
    method: "POST",
    headers: { authorization: "Bearer valid", "content-type": "application/json" },
    body: JSON.stringify({
      ingress: "shared",
      subdomain: "work--app",
      target: { containers: [], port: 4096, protocol: "http" }
    })
  });

  // Then: target inspection accepts only that grant and route creation succeeds.
  const body = await response.text();
  expect(response.status, body).toBe(201);
  expect(runner.relay).toMatchObject({ listenHost: "172.18.0.2", host: "127.0.0.1", port: 4096 });
});

class TrustedDeviceRouteRunner implements StreamingCommandRunner {
  relay: Record<string, unknown> | undefined;

  constructor(private readonly record: WorkspaceRecord) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    const resources = workspaceRuntimeResources(this.record);
    if (args[0] === "container") {
      return result(command, args, {
        Id: "owned-container-id",
        Config: { Image: this.record.image, Labels: {
          "dim.managed": "true",
          "dim.workspace-id": this.record.id,
          "dim.resource": "container",
          "dim.workspace-schema": "10"
        } },
        HostConfig: {
          Runtime: "sysbox-runc",
          Privileged: false,
          OomScoreAdj: 500,
          Devices: [],
          DeviceCgroupRules: ["c 10:232 rw"],
          NetworkMode: resources.network
        },
        State: { Running: true },
        Mounts: [
          ...([['home', '/home/dim'], ['checkout', '/workspace'], ['docker', '/var/lib/docker'], ['tmp', '/mnt/dim-tmp']] as const)
            .map(([role, Destination]) => ({ Type: "volume", RW: true, Destination, Name: resources[role] })),
          { Type: "bind", RW: true, Destination: device.containerPath, Source: device.hostPath }
        ],
        NetworkSettings: { Networks: { [resources.network]: { IPAddress: "172.18.0.2" } } }
      });
    }
    this.relay = JSON.parse(Buffer.from(args.at(-1) ?? "", "base64url").toString()) as Record<string, unknown>;
    return result(command, args, { port: 23456 });
  }

  async runStreaming(): Promise<number> {
    throw new Error("route resolution must not execute host streams");
  }
}

function result(command: string, args: string[], value: unknown): CommandResult {
  return { command, args, exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await listen(server);
  const selected = port(server);
  await close(server);
  return selected;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function port(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return address.port;
}
