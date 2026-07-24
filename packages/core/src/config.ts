import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCondition } from "./errors.js";
import type { DevInfraConfig } from "./types.js";

export const DEFAULT_CONFIG: DevInfraConfig = {
  stateRoot: ".dev-infra/state",
  managedGitHost: {
    kind: "bare-git-pr",
    remote: "ssh://git.example.internal/dev-infra-manager.git",
    protectedRefs: ["refs/heads/main"]
  },
  secretRuntime: {
    endpoint: "http://127.0.0.1:7090",
    repo: "trusted-runtime",
    approvedRef: "refs/heads/main",
    image: "dev-infra-secret-runtime:latest",
    containerName: "dev-infra-secret-runtime",
    contextPath: ".",
    dockerfile: "Dockerfile",
    publish: ["127.0.0.1:7090:7090"]
  }
};

export async function writeDefaultConfig(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
}

export async function loadConfig(path: string): Promise<DevInfraConfig> {
  return normalizeConfig(JSON.parse(await readFile(path, "utf8")) as unknown, path);
}

export function normalizeConfig(raw: unknown, source = "config"): DevInfraConfig {
  assertObject(raw, source);
  const value = raw as Partial<DevInfraConfig>;

  assertString(value.stateRoot, "stateRoot");

  assertObject(value.managedGitHost, "managedGitHost");
  assertCondition(value.managedGitHost.kind === "bare-git-pr", "managedGitHost.kind must be bare-git-pr");
  assertString(value.managedGitHost.remote, "managedGitHost.remote");
  assertStringArray(value.managedGitHost.protectedRefs, "managedGitHost.protectedRefs");
  assertCondition(value.managedGitHost.protectedRefs.length > 0, "managedGitHost.protectedRefs must not be empty");
  for (const ref of value.managedGitHost.protectedRefs) assertGitRef(ref, `managedGitHost.protectedRefs.${ref}`);

  assertObject(value.secretRuntime, "secretRuntime");
  assertString(value.secretRuntime.endpoint, "secretRuntime.endpoint");
  assertString(value.secretRuntime.repo, "secretRuntime.repo");
  assertString(value.secretRuntime.approvedRef, "secretRuntime.approvedRef");
  assertString(value.secretRuntime.image, "secretRuntime.image");
  assertString(value.secretRuntime.containerName, "secretRuntime.containerName");
  assertString(value.secretRuntime.contextPath, "secretRuntime.contextPath");
  assertString(value.secretRuntime.dockerfile, "secretRuntime.dockerfile");
  if (value.secretRuntime.envFile !== undefined) assertString(value.secretRuntime.envFile, "secretRuntime.envFile");
  assertStringArray(value.secretRuntime.publish, "secretRuntime.publish");

  return {
    stateRoot: resolve(value.stateRoot),
    managedGitHost: value.managedGitHost,
    secretRuntime: value.secretRuntime
  };
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  assertCondition(typeof value === "object" && value !== null && !Array.isArray(value), `${path} must be an object`);
}

function assertString(value: unknown, path: string): asserts value is string {
  assertCondition(typeof value === "string" && value.length > 0, `${path} must be a non-empty string`);
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  assertCondition(Array.isArray(value), `${path} must be an array`);
  for (const [index, entry] of value.entries()) assertString(entry, `${path}.${index}`);
}

function assertGitRef(value: string, path: string): void {
  assertCondition(value.startsWith("refs/"), `${path} must be a full Git ref under refs/`);
  assertCondition(!value.includes(".."), `${path} must not contain '..'`);
  assertCondition(!/[\s~^:?*[\]\\]/.test(value), `${path} contains characters that are unsafe in Git refs`);
  assertCondition(!value.endsWith("/") && !value.endsWith(".") && !value.includes("//"), `${path} is not a valid full Git ref`);
}
