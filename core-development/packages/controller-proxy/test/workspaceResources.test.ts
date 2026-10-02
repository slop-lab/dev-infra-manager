import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkspaceResources,
  workspaceNprocCount,
  WorkspaceResourcesUnavailableError
} from "../../../../core/packages/controller-proxy/src/workspace-resources.js";

describe("workspace resources helper", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanup.splice(0).map((item) => item())));

  it("reads only the fixed workspace resources route", async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-resources-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = path.join(root, "resources.sock");
    const requests: Array<{
      readonly method: string | undefined;
      readonly url: string | undefined;
    }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      response.setHeader("content-type", "application/json");
      response.end('{"cpuCount":"2.5","memory":"5g","pidsLimit":"500"}\n');
    });
    await listenServer(server, socketPath);
    cleanup.push(() => closeServer(server));

    // When
    const resources = await readWorkspaceResources(socketPath);

    // Then
    expect(resources).toEqual({ cpuCount: "2.5", memory: "5g", pidsLimit: "500" });
    expect(requests).toEqual([{ method: "GET", url: "/api/workspace/resources" }]);
  });

  it.each([
    { cpuCount: "2.5", visibleCpuCount: 8, expected: 2 },
    { cpuCount: "12", visibleCpuCount: 6, expected: 6 },
    { cpuCount: "0.5", visibleCpuCount: 8, expected: 1 }
  ])("returns $expected for CPU $cpuCount with $visibleCpuCount visible CPUs", ({
    cpuCount,
    visibleCpuCount,
    expected
  }) => {
    // Given
    const resources = { cpuCount, memory: "5g", pidsLimit: "500" };

    // When
    const result = workspaceNprocCount(resources, visibleCpuCount);

    // Then
    expect(result).toBe(expected);
  });

  it.each(["max", "", "unavailable", "NaN"])(
    "rejects unavailable CPU assignment %j instead of using host CPUs",
    (cpuCount) => {
      // Given
      const resources = { cpuCount, memory: "5g", pidsLimit: "500" };

      // When
      const action = () => workspaceNprocCount(resources, 64);

      // Then
      expect(action).toThrow(WorkspaceResourcesUnavailableError);
    }
  );
});

function listenServer(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}
