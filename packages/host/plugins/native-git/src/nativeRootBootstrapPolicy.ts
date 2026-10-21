import { nativeRepositoryPolicyRevision, parseAuthoritativeImportedRootPolicy, type NativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
import { parseDocument } from "yaml";
import { UserError } from "@slop-lab/dim-host-core";
import { normalizeRepositoryRef } from "./repositoryRef.js";

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
    ["schemaVersion", "repositories"], ["policy"], "native bootstrap manifest");
  if (manifest.schemaVersion !== 1 || !isRecord(manifest.repositories) || !Object.keys(manifest.repositories).length) {
    throw new UserError("native bootstrap manifest requires schemaVersion 1 and nonempty repositories");
  }
  const entries = new Map<string, { ref?: string; protect: readonly string[]; upstream?: unknown; publish?: unknown }>();
  for (const [id, value] of Object.entries(manifest.repositories)) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) throw new UserError("invalid repository ID in native bootstrap manifest");
    const entry = exactRecord(value, ["protect"], ["ref", "upstream", "publish"], `native bootstrap repository '${id}'`);
    if (entry.ref !== undefined && typeof entry.ref !== "string") throw new UserError("repository ref must be a string");
    if (!Array.isArray(entry.protect) || !entry.protect.length || entry.protect.length > 64
      || !entry.protect.every((pattern: unknown) => typeof pattern === "string" && pattern.length > 0 && pattern.length <= 512 && !/[\x00-\x20\x7f]/.test(pattern))) {
      throw new UserError("repository protect must contain 1–64 branch patterns");
    }
    entries.set(id, { ...(entry.ref === undefined ? {} : { ref: normalizeRepositoryRef(entry.ref) }), protect: entry.protect,
      ...(entry.upstream === undefined ? {} : { upstream: entry.upstream }), ...(entry.publish === undefined ? {} : { publish: entry.publish }) });
  }
  const entry = entries.get(repositoryId);
  if (!entry) throw new UserError("native bootstrap manifest does not name the selected repository");
  const normalizedRef = normalizeRepositoryRef(selectedRef);
  if (entry.ref !== undefined && entry.ref !== normalizedRef) {
    throw new UserError("native bootstrap selected ref conflicts with the reviewed root ref");
  }
  const branch = normalizedRef.slice("refs/heads/".length);
  if (!entry.protect.some((pattern) => matchesProtectionPattern(branch, pattern))) {
    throw new UserError("native bootstrap root branch is not protected by the reviewed manifest");
  }
  let extensions = manifest.policy;
  if (entry.upstream !== undefined || entry.publish !== undefined) {
    if (extensions !== undefined && !isRecord(extensions)) throw new UserError("repository policy must be an object");
    if (isRecord(extensions) && Object.hasOwn(extensions, "git-sync")) throw new UserError("declare git-sync through either repository upstream/publish or policy.git-sync");
    // The optional control-plane plugin validates transport, refs and credentials policy.
    extensions = { ...extensions, "git-sync": { ...(entry.upstream === undefined ? {} : { upstream: entry.upstream }),
      ...(entry.publish === undefined ? {} : { publish: entry.publish }) } };
  }
  return compileNativeRepositoryBootstrapPolicy({ repositoryId, protectedRef: normalizedRef, extensions });
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
