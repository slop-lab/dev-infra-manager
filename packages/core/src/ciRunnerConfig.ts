import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { UserError } from "./errors.js";
import type { CiRunnerConfigProvenance } from "./lifecycleTypes.js";
import type { ProtectedRootSnapshot } from "./protectedRootSnapshot.js";

export const CI_RUNNER_CAPABILITIES = ["nested-docker"] as const;
export type CiRunnerCapability = (typeof CI_RUNNER_CAPABILITIES)[number];
export type CiRunnerWorkloadKind = "ordinary" | "integration";

export type CiRunnerWorkload = {
  readonly labels: readonly string[];
  readonly image: string;
  readonly tools: readonly string[];
  readonly capabilities: readonly CiRunnerCapability[];
};

export type CiRunnerConfig = {
  readonly schemaVersion: 1;
  readonly workloads: Readonly<Record<CiRunnerWorkloadKind, CiRunnerWorkload>>;
};

export type ResolvedCiRunnerConfig = {
  readonly config: CiRunnerConfig;
  readonly provenance: CiRunnerConfigProvenance;
};

export function parseCiRunnerConfigYaml(source: string, label = ".dim/ci/runner.yml"): CiRunnerConfig {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new UserError(`${label} is invalid YAML: ${document.errors[0]?.message ?? "unknown parse error"}`);
  }
  const root = object(document.toJS({ maxAliasCount: 0 }), label);
  exactKeys(root, ["schemaVersion", "workloads"], label);
  if (root.schemaVersion !== 1) throw new UserError(`${label}.schemaVersion must be 1`);
  const workloads = object(root.workloads, `${label}.workloads`);
  exactKeys(workloads, ["ordinary", "integration"], `${label}.workloads`);
  const ordinary = workload(workloads.ordinary, `${label}.workloads.ordinary`);
  const integration = workload(workloads.integration, `${label}.workloads.integration`);
  const labels = [...ordinary.labels, ...integration.labels];
  if (new Set(labels).size !== labels.length) {
    throw new UserError(`${label}.workloads labels must not contain duplicates`);
  }
  if (labels.includes("dim-qemu")) throw new UserError(`${label} must not redefine DIM-owned label 'dim-qemu'`);
  if (!integration.capabilities.includes("nested-docker")) {
    throw new UserError(`${label}.workloads.integration.capabilities must include nested-docker`);
  }
  return { schemaVersion: 1, workloads: { ordinary, integration } };
}

export async function loadCiRunnerConfig(snapshot: ProtectedRootSnapshot): Promise<ResolvedCiRunnerConfig> {
  if (!snapshot.rootRef.startsWith("refs/heads/")) {
    throw new UserError("CI runner config source ref must be a concrete protected branch");
  }
  if (!/^[0-9a-f]{40,64}$/.test(snapshot.rootCommit)) {
    throw new UserError("CI runner config source commit must be a complete Git commit");
  }
  const target = join(snapshot.rootSnapshotPath, ".dim", "ci", "runner.yml");
  let source: string;
  try {
    source = await readFile(target, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new UserError("Project .dim/ci/runner.yml is required");
    throw error;
  }
  return {
    config: parseCiRunnerConfigYaml(source),
    provenance: {
      sourceRef: snapshot.rootRef,
      sourceCommit: snapshot.rootCommit,
      configDigest: createHash("sha256").update(source).digest("hex")
    }
  };
}

export function ciRunnerLabels(config: CiRunnerConfig): string {
  return workloadLabels(config.workloads.ordinary).join(",");
}

export function qemuCiRunnerLabels(config: CiRunnerConfig): string {
  return qemuCiRunnerLabelNames(config)
    .map((label) => `${label}:docker://${config.workloads.integration.image}`)
    .join(",");
}

export function qemuCiRunnerLabelNames(config: CiRunnerConfig): readonly string[] {
  return [...config.workloads.integration.labels, "dim-qemu"];
}

function workload(value: unknown, label: string): CiRunnerWorkload {
  const input = object(value, label);
  exactKeys(input, ["labels", "image", "tools", "capabilities"], label);
  const labels = stringArray(input.labels, `${label}.labels`, safeLabel);
  if (labels.length === 0) throw new UserError(`${label}.labels must not be empty`);
  const tools = stringArray(input.tools, `${label}.tools`, safeTool);
  if (tools.length === 0) throw new UserError(`${label}.tools must not be empty`);
  const capabilities = stringArray(input.capabilities, `${label}.capabilities`, safeCapability);
  const image = string(input.image, `${label}.image`);
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new UserError(`${label}.image must be a digest-pinned container image without a tag`);
  }
  return { labels, image, tools, capabilities };
}

function workloadLabels(workload: CiRunnerWorkload): string[] {
  return workload.labels.map((label) => `${label}:docker://${workload.image}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new UserError(`${label} contains unknown field '${unknown}'`);
  const missing = allowed.find((key) => value[key] === undefined);
  if (missing !== undefined) throw new UserError(`${label}.${missing} is required`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`${label} must be a non-empty string`);
  return value;
}

function stringArray<T extends string>(
  value: unknown,
  label: string,
  parse: (value: string, label: string) => T
): readonly T[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UserError(`${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) throw new UserError(`${label} must not contain duplicates`);
  return value.map((item, index) => parse(item, `${label}[${index}]`));
}

function safeLabel(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new UserError(`${label} must be a safe runner label`);
  return value;
}

function safeTool(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) throw new UserError(`${label} must be a safe executable name`);
  return value;
}

function safeCapability(value: string, label: string): CiRunnerCapability {
  const capability = CI_RUNNER_CAPABILITIES.find((candidate) => candidate === value);
  if (capability === undefined) throw new UserError(`${label} contains unknown capability '${value}'`);
  return capability;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
