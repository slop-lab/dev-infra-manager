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
  readonly defaultRef?: string;
  readonly branches?: Readonly<Record<string, { readonly review: boolean }>>;
}): NativeRepositoryBootstrapPolicy {
  if (Object.keys(input).some((key) => !["repositoryId", "protectedRef", "extensions", "defaultRef", "branches"].includes(key))) {
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
  const defaultRef = input.defaultRef ?? "refs/heads/main";
  const branches = input.branches ?? { "refs/heads/main": { review: true }, "refs/heads/development": { review: false },
    ...(protectedRef === "refs/heads/main" || protectedRef === "refs/heads/development" ? {} : { [protectedRef]: { review: true } }),
    ...(defaultRef === "refs/heads/main" || defaultRef === "refs/heads/development" || defaultRef === protectedRef ? {} : { [defaultRef]: { review: true } }) };
  try {
    const policy = parseAuthoritativeImportedRootPolicy({ schemaVersion: 1, protectedRef, defaultRef, branches, extensions,
      policyRevision: nativeRepositoryPolicyRevision({ protectedRef, defaultRef, branches, extensions }) });
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
  const entries = new Map<string, { ref?: string; protect: readonly string[]; defaultRef?: string; branches?: Readonly<Record<string, { readonly review: boolean }>>; upstream?: unknown; publish?: unknown }>();
  for (const [id, value] of Object.entries(manifest.repositories)) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) throw new UserError("invalid repository ID in native bootstrap manifest");
    const entry = exactRecord(value, [], ["ref", "protect", "defaultBranch", "branches", "upstream", "publish"], `native bootstrap repository '${id}'`);
    if (entry.ref !== undefined && typeof entry.ref !== "string") throw new UserError("repository ref must be a string");
    const protect = entry.protect ?? ["main", "development"];
    if (!Array.isArray(protect) || !protect.length || protect.length > 64
      || !protect.every((pattern: unknown) => typeof pattern === "string" && pattern.length > 0 && pattern.length <= 512 && !/[\x00-\x20\x7f]/.test(pattern))) {
      throw new UserError("repository protect must contain 1–64 branch patterns");
    }
    if (entry.defaultBranch !== undefined && (typeof entry.defaultBranch !== "string" || !safeHeadRef(normalizeRepositoryRef(entry.defaultBranch)))) throw new UserError("defaultBranch must be a safe branch");
    let branches: Record<string, { readonly review: boolean }> | undefined;
    if (entry.branches !== undefined) {
      if (!isRecord(entry.branches) || Object.keys(entry.branches).length === 0) throw new UserError("repository branches must be a nonempty branch policy map");
      branches = {};
      for (const [branch, options] of Object.entries(entry.branches)) {
        const ref = normalizeRepositoryRef(branch);
        const rule = exactRecord(options, ["review"], [], `repository branch '${branch}'`);
        if (!safeHeadRef(ref) || typeof rule.review !== "boolean" || Object.hasOwn(branches, ref)) throw new UserError("repository branch policy is invalid or duplicated");
        branches[ref] = { review: rule.review };
      }
    }
    entries.set(id, { ...(entry.ref === undefined ? {} : { ref: normalizeRepositoryRef(entry.ref) }), protect,
      ...(entry.defaultBranch === undefined ? {} : { defaultRef: normalizeRepositoryRef(entry.defaultBranch) }), ...(branches === undefined ? {} : { branches }),
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
  const defaultRef = entry.defaultRef ?? "refs/heads/main";
  const branches: Record<string, { readonly review: boolean }> = { "refs/heads/main": { review: true }, "refs/heads/development": { review: false },
    [normalizedRef]: { review: normalizedRef !== "refs/heads/development" }, [defaultRef]: { review: defaultRef !== "refs/heads/development" }, ...entry.branches };
  // Concrete protect entries declare additional managed branches; wildcard entries select the imported ref.
  for (const pattern of entry.protect) if (!pattern.includes("*") && !pattern.includes("?")) {
    const ref = normalizeRepositoryRef(pattern);
    if (!safeHeadRef(ref)) throw new UserError("protected branch is unsafe");
    branches[ref] ??= { review: ref !== "refs/heads/development" };
  }
  return compileNativeRepositoryBootstrapPolicy({ repositoryId, protectedRef: normalizedRef, defaultRef, branches, extensions });
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
