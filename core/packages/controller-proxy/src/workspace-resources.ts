export type WorkspaceResources = {
  readonly cpuCount: string;
  readonly memory: string;
  readonly pidsLimit: string;
};

export class WorkspaceResourcesUnavailableError extends Error {
  readonly name = "WorkspaceResourcesUnavailableError";
}

export async function readWorkspaceResources(socketPath: string): Promise<WorkspaceResources> {
  const response = await new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const request = http.request({
      socketPath,
      method: "GET",
      path: "/api/workspace/resources"
    }, async (incoming) => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          size += bytes.length;
          if (size > 4_096) {
            throw new WorkspaceResourcesUnavailableError("workspace resources response exceeds 4096 bytes");
          }
          chunks.push(bytes);
        }
        resolve({
          status: incoming.statusCode ?? 500,
          body: Buffer.concat(chunks).toString("utf8")
        });
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
  if (response.status !== 200) {
    throw new WorkspaceResourcesUnavailableError(`workspace resources request failed (${response.status})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch (error) {
    throw new WorkspaceResourcesUnavailableError("workspace resources response is not valid JSON", { cause: error });
  }
  if (!isObject(value)
    || typeof value.cpuCount !== "string"
    || typeof value.memory !== "string"
    || typeof value.pidsLimit !== "string") {
    throw new WorkspaceResourcesUnavailableError("workspace resources response is unavailable");
  }
  return {
    cpuCount: value.cpuCount,
    memory: value.memory,
    pidsLimit: value.pidsLimit
  };
}

export function workspaceNprocCount(resources: WorkspaceResources, visibleCpuCount: number): number {
  const cpuCount = Number(resources.cpuCount);
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(resources.cpuCount) || !Number.isFinite(cpuCount) || cpuCount <= 0) {
    throw new WorkspaceResourcesUnavailableError("workspace CPU assignment is unavailable");
  }
  if (!Number.isSafeInteger(visibleCpuCount) || visibleCpuCount < 1) {
    throw new WorkspaceResourcesUnavailableError("visible CPU count is unavailable");
  }
  return Math.max(1, Math.min(Math.floor(cpuCount), visibleCpuCount));
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import http from "node:http";
