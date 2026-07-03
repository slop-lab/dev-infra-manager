import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCondition, UserError } from "./errors.js";
import { parseBytes } from "./size.js";
import type { DevInfraConfig, ResourceProfile } from "./types.js";

interface RawResourceProfile {
  cpuCount: number;
  memoryBytes: number | string;
  pidsLimit: number;
  diskBytes: number | string;
  timeoutSeconds: number;
}

type RawConfig = Omit<DevInfraConfig, "resourceProfiles"> & {
  resourceProfiles: Record<string, RawResourceProfile>;
};

export const DEFAULT_CONFIG: DevInfraConfig = {
  stateRoot: ".dev-infra/state",
  jobMountRoot: ".dev-infra/mounts",
  managedGitHost: {
    kind: "bare-git-pr",
    remote: "ssh://git.example.internal/dev-infra-manager.git",
    protectedRefs: ["refs/heads/main"]
  },
  resourceProfiles: {
    default: {
      cpuCount: 2,
      memoryBytes: parseBytes("4GiB"),
      pidsLimit: 2048,
      diskBytes: parseBytes("20GiB"),
      timeoutSeconds: 3600
    }
  },
  agent: {
    image: "dev-infra-agent-workspace:latest",
    runtime: "sysbox-runc",
    workspacePath: "/workspace",
    runtimeDataPath: "/var/lib/docker",
    env: {},
    gitEnv: {}
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
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return normalizeConfig(raw, path);
}

export function normalizeConfig(raw: unknown, source = "config"): DevInfraConfig {
  assertObject(raw, source);
  const value = raw as Partial<RawConfig>;

  assertString(value.stateRoot, "stateRoot");
  assertString(value.jobMountRoot, "jobMountRoot");
  assertObject(value.managedGitHost, "managedGitHost");
  assertCondition(value.managedGitHost.kind === "bare-git-pr", "managedGitHost.kind must be bare-git-pr");
  assertString(value.managedGitHost.remote, "managedGitHost.remote");
  assertStringArray(value.managedGitHost.protectedRefs, "managedGitHost.protectedRefs");
  assertCondition(value.managedGitHost.protectedRefs.length > 0, "managedGitHost.protectedRefs must not be empty");
  for (const ref of value.managedGitHost.protectedRefs) {
    assertGitRef(ref, `managedGitHost.protectedRefs.${ref}`);
  }

  assertObject(value.resourceProfiles, "resourceProfiles");
  const resourceProfiles: Record<string, ResourceProfile> = {};
  for (const [name, profile] of Object.entries(value.resourceProfiles)) {
    resourceProfiles[name] = normalizeProfile(profile, `resourceProfiles.${name}`);
  }
  assertCondition(Object.keys(resourceProfiles).length > 0, "resourceProfiles must not be empty");

  assertObject(value.agent, "agent");
  assertString(value.agent.image, "agent.image");
  assertString(value.agent.runtime, "agent.runtime");
  assertAbsoluteContainerPath(value.agent.workspacePath, "agent.workspacePath");
  assertAbsoluteContainerPath(value.agent.runtimeDataPath, "agent.runtimeDataPath");
  assertStringRecord(value.agent.env, "agent.env");
  assertStringRecord(value.agent.gitEnv, "agent.gitEnv");

  assertObject(value.secretRuntime, "secretRuntime");
  assertString(value.secretRuntime.endpoint, "secretRuntime.endpoint");
  assertString(value.secretRuntime.repo, "secretRuntime.repo");
  assertString(value.secretRuntime.approvedRef, "secretRuntime.approvedRef");
  assertString(value.secretRuntime.image, "secretRuntime.image");
  assertString(value.secretRuntime.containerName, "secretRuntime.containerName");
  assertString(value.secretRuntime.contextPath, "secretRuntime.contextPath");
  assertString(value.secretRuntime.dockerfile, "secretRuntime.dockerfile");
  if (value.secretRuntime.envFile !== undefined) {
    assertString(value.secretRuntime.envFile, "secretRuntime.envFile");
  }
  assertStringArray(value.secretRuntime.publish, "secretRuntime.publish");

  return {
    stateRoot: resolve(value.stateRoot),
    jobMountRoot: resolve(value.jobMountRoot),
    managedGitHost: value.managedGitHost,
    resourceProfiles,
    agent: value.agent,
    secretRuntime: value.secretRuntime
  };
}

function normalizeProfile(raw: unknown, path: string): ResourceProfile {
  assertObject(raw, path);
  const profile = raw as Partial<RawResourceProfile>;
  assertPositiveInteger(profile.cpuCount, `${path}.cpuCount`);
  assertPositiveInteger(profile.pidsLimit, `${path}.pidsLimit`);
  assertPositiveInteger(profile.timeoutSeconds, `${path}.timeoutSeconds`);

  return {
    cpuCount: profile.cpuCount,
    memoryBytes: parseBytesField(profile.memoryBytes, `${path}.memoryBytes`),
    pidsLimit: profile.pidsLimit,
    diskBytes: parseBytesField(profile.diskBytes, `${path}.diskBytes`),
    timeoutSeconds: profile.timeoutSeconds
  };
}

function parseBytesField(value: unknown, path: string): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new UserError(`${path} must be a positive byte count or size string`);
  }
  return parseBytes(value);
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  assertCondition(typeof value === "object" && value !== null && !Array.isArray(value), `${path} must be an object`);
}

function assertString(value: unknown, path: string): asserts value is string {
  assertCondition(typeof value === "string" && value.length > 0, `${path} must be a non-empty string`);
}

function assertStringRecord(value: unknown, path: string): asserts value is Record<string, string> {
  assertObject(value, path);
  for (const [key, entry] of Object.entries(value)) {
    assertCondition(typeof entry === "string", `${path}.${key} must be a string`);
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  assertCondition(Array.isArray(value), `${path} must be an array`);
  for (const [index, entry] of value.entries()) {
    assertString(entry, `${path}.${index}`);
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  assertCondition(typeof value === "number" && Number.isSafeInteger(value) && value > 0, `${path} must be a positive integer`);
}

function assertAbsoluteContainerPath(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  assertCondition(value.startsWith("/"), `${path} must be an absolute container path`);
}

function assertGitRef(value: string, path: string): void {
  assertCondition(value.startsWith("refs/"), `${path} must be a full Git ref under refs/`);
  assertCondition(!value.includes(".."), `${path} must not contain '..'`);
  assertCondition(!/[\s~^:?*[\]\\]/.test(value), `${path} contains characters that are unsafe in Git refs`);
  assertCondition(!value.endsWith("/") && !value.endsWith(".") && !value.includes("//"), `${path} is not a valid full Git ref`);
}
