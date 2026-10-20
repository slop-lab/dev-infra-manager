import { nativeRepositoryPolicyRevision, parseAuthoritativeImportedRootPolicy, type NativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
import { parseDocument } from "yaml";
import { UserError } from "@slop-lab/dim-host-core";
import { normalizeRepositoryRef } from "./repositoryRef.js";
import { assertRepositorySetUrlsArePortable, normalizeRepositorySet } from "./repositorySetValidation.js";

const maximumManifestBytes = 64 * 1024;
export type NativeRepositoryBootstrapPolicy = {
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly repositoryPolicy: NativeImportedRootPolicy;
};

/** The host transports feature declarations; their owning enabled plugins validate their meaning. */
export function compileNativeRepositoryBootstrapPolicy(input: {
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly extensions?: unknown;
}): NativeRepositoryBootstrapPolicy {
  if (Object.keys(input).some((key) => !["repositoryId", "protectedRef", "extensions"].includes(key))) {
    throw new UserError("repository policy input contains unknown fields");
  }
  const repositoryId = input.repositoryId;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(repositoryId)) throw new UserError("repository ID must contain lowercase letters, digits and internal hyphens");
  const protectedRef = normalizeRepositoryRef(input.protectedRef);
  if (protectedRef !== input.protectedRef || !safeHeadRef(protectedRef)) {
    throw new UserError("protected ref must be a safe concrete branch outside proposals");
  }
  const extensions = input.extensions ?? {};
  if (!isRecord(extensions)) throw new UserError("repository policy extensions must be an object");
  try {
    const policy = parseAuthoritativeImportedRootPolicy({ schemaVersion: 1, protectedRef, extensions,
      policyRevision: nativeRepositoryPolicyRevision({ protectedRef, extensions }) });
    if (Buffer.byteLength(JSON.stringify(policy)) > maximumManifestBytes) throw new Error("policy exceeds 64 KiB");
    return { repositoryId, protectedRef, repositoryPolicy: policy };
  } catch (cause) {
    throw new UserError("repository policy is invalid", { cause });
  }
}

export function parseNativeRootBootstrapManifestYaml(
  source: string,
  selectedRef: string,
  repositoryId: string
): NativeRepositoryBootstrapPolicy {
  if (Buffer.byteLength(source, "utf8") > maximumManifestBytes) {
    throw new UserError("native bootstrap manifest exceeds 64 KiB");
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new UserError(`native bootstrap manifest is invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  const manifest = exactRecord(document.toJS({ maxAliasCount: 0 }),
    ["schemaVersion", "repositories"], ["upstreams", "policy"], "native bootstrap manifest");
  const set = normalizeRepositorySet({
    schemaVersion: manifest.schemaVersion, repositories: manifest.repositories, upstreams: manifest.upstreams
  }, "native bootstrap manifest");
  assertRepositorySetUrlsArePortable(set, "native bootstrap manifest");
  const entry = set.repositories[repositoryId];
  if (!entry) throw new UserError("native bootstrap manifest does not name the selected repository");
  const normalizedRef = normalizeRepositoryRef(selectedRef);
  if (entry.ref !== undefined && entry.ref !== normalizedRef) {
    throw new UserError("native bootstrap selected ref conflicts with the reviewed root ref");
  }
  const branch = normalizedRef.slice("refs/heads/".length);
  if (!entry.protectedPatterns.some((pattern) => matchesProtectionPattern(branch, pattern))) {
    throw new UserError("native bootstrap root branch is not protected by the reviewed manifest");
  }
  return compileNativeRepositoryBootstrapPolicy({ repositoryId, protectedRef: normalizedRef, extensions: manifest.policy });
}

function safeHeadRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") && !ref.startsWith("refs/heads/proposals/")
    && !ref.endsWith("/") && !ref.endsWith(".") && !ref.endsWith(".lock")
    && !ref.includes("..") && !ref.includes("@{") && !ref.includes("\\")
    && !/[\x00-\x20\x7f~^:?*[\]]/.test(ref)
    && ref.slice("refs/heads/".length).split("/")
      .every((component) => component.length > 0 && !component.startsWith("."));
}

function matchesProtectionPattern(branch: string, pattern: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${expression}$`).test(branch);
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string)
  : Readonly<Record<string, unknown>> {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new UserError(`${label} contains missing or unknown fields`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
