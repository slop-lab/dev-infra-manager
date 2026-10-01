import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { expect } from "vitest";
import { BUILTIN_CI_RUNNER_DEFAULTS } from "../../../../core/packages/core/src/ciRunner.js";
import { ciRunnerLabels, parseCiRunnerConfigYaml } from "../../../../core/packages/core/src/ciRunnerConfig.js";
import type { LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";

export const options = {
  ciRunnerDefaultCpus: BUILTIN_CI_RUNNER_DEFAULTS.cpus,
  ciRunnerDefaultMemory: BUILTIN_CI_RUNNER_DEFAULTS.memory,
  ciRunnerDefaultPidsLimit: BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit
} as LifecycleOptions;

export const runnerImage = `gitea/runner-images@sha256:${"a".repeat(64)}`;

export const runnerLabels = ciRunnerLabels(parseCiRunnerConfigYaml(`schemaVersion: 1
workloads:
  ordinary: {labels: [dim, ubuntu-24.04], image: ${runnerImage}, tools: [bash], capabilities: []}
  integration: {labels: [dim-container-integration], image: ${runnerImage}, tools: [bash, docker], capabilities: [nested-docker]}
`));

export const temporaryDirectories: string[] = [];

export const hasPython = spawnSync("python3", ["--version"]).status === 0;

export async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate webhook test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function sendWorkflowJob(port: number, id: number, action: "queued" | "in_progress" | "completed"): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/workflow-job`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "Content-Type": "application/json",
      "X-Gitea-Event": "workflow_job"
    },
    body: JSON.stringify({ action, workflow_job: { id, labels: ["dim-qemu"] } })
  });
  expect(response.status).toBe(202);
}

export async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for QEMU webhook test condition");
}
