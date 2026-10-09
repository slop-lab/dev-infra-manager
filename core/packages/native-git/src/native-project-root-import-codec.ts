import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseAuthoritativeImportedRootPolicy,
  parseLegacyImportedRootPolicy,
  nativeImportedRootPolicySchema,
  type NativeImportedRootPolicy,
  type StoredImportedRootPolicy
} from "./native-imported-root-policy.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const hostIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const generationId = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const finalizeSelector = z.object({
  schemaVersion: z.literal(1),
  generationId,
  importNonce: z.string().uuid(),
  bundleDigest: digest
}).strict().readonly();
const importInput = z.object({
  serviceId: z.literal("native-main"),
  projectId: identifier,
  rootRepositoryId: z.literal("root"),
  protectedRef: z.string(),
  expectedCommit: objectId,
  policy: nativeImportedRootPolicySchema
}).strict().readonly();
const storedRow = z.object({
  serviceId: z.literal("native-main"),
  projectId: identifier,
  rootRepositoryId: z.literal("root"),
  ownerHostId: hostIdentifier,
  generationId,
  importNonce: z.string().uuid(),
  protectedRef: z.string(),
  expectedCommit: objectId,
  policyJson: z.string(),
  policyDigest: digest,
  bundleDigest: digest.nullable(),
  bundleSize: z.number().int().positive().max(256 * 1024 * 1024).nullable(),
  resolvedTree: objectId.nullable(),
  phase: z.union([
    z.literal("intent"), z.literal("bundle-durable"), z.literal("installing"),
    z.literal("objects-installed"), z.literal("root-imported")
  ])
}).strict().readonly();

type NativeProjectRootImportCommon = {
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly ownerHostId: string;
  readonly generationId: string;
  readonly importNonce: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly policyDigest: string;
};
type NativeProjectRootImportBase = NativeProjectRootImportCommon & StoredImportedRootPolicy;

export type NativeProjectRootImportIntent = NativeProjectRootImportBase & {
  readonly bundleDigest: null;
  readonly bundleSize: null;
  readonly resolvedTree: null;
  readonly phase: "intent";
};
export type NativeProjectRootImportDurable = NativeProjectRootImportBase & {
  readonly bundleDigest: string;
  readonly bundleSize: number;
  readonly resolvedTree: null;
  readonly phase: "bundle-durable" | "installing";
};
export type NativeProjectRootImportInstalled = NativeProjectRootImportBase & {
  readonly bundleDigest: string;
  readonly bundleSize: number;
  readonly resolvedTree: string;
  readonly phase: "objects-installed" | "root-imported";
};
export type NativeProjectRootImport =
  | NativeProjectRootImportIntent
  | NativeProjectRootImportDurable
  | NativeProjectRootImportInstalled;
export type NativeProjectRootImportInput = z.infer<typeof importInput>;
export type NativeProjectRootImportFinalizeSelector = z.infer<typeof finalizeSelector>;

export function parseNativeProjectRootImportFinalizeSelector(
  value: unknown
): NativeProjectRootImportFinalizeSelector {
  const result = finalizeSelector.safeParse(value);
  if (!result.success) {
    throw new NativeProjectRootImportStateError("native Project root import finalize selector is invalid", {
      cause: result.error
    });
  }
  return result.data;
}

export function parseNativeProjectRootImportInput(value: unknown): NativeProjectRootImportInput {
  const result = importInput.safeParse(value);
  if (!result.success) {
    throw new NativeProjectRootImportStateError("native Project root import intent is invalid", { cause: result.error });
  }
  let policy: NativeImportedRootPolicy;
  try {
    policy = parseAuthoritativeImportedRootPolicy(result.data.policy);
  } catch (error) {
    throw new NativeProjectRootImportStateError("native Project root import policy is invalid", { cause: error });
  }
  if (result.data.protectedRef !== policy.protectedRef) {
    throw new NativeProjectRootImportStateError("native Project root import protected ref conflicts with policy");
  }
  return { ...result.data, policy };
}

export function parseNativeProjectRootImportRow(row: unknown): NativeProjectRootImport {
  if (!isRecord(row)) throw new NativeProjectRootImportStateError("native Project root import intent row is invalid");
  const result = storedRow.safeParse({
    serviceId: row.service_id, projectId: row.project_id, rootRepositoryId: row.root_repository_id,
    ownerHostId: row.owner_host_id, generationId: row.generation_id, importNonce: row.import_nonce,
    protectedRef: row.protected_ref, expectedCommit: row.expected_commit, policyJson: row.policy_json,
    policyDigest: row.policy_sha256, bundleDigest: row.bundle_sha256, bundleSize: row.bundle_size,
    resolvedTree: row.resolved_tree, phase: row.phase
  });
  if (!result.success) {
    throw new NativeProjectRootImportStateError("native Project root import intent row is invalid", { cause: result.error });
  }
  let parsedPolicy: unknown;
  try {
    parsedPolicy = JSON.parse(result.data.policyJson);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new NativeProjectRootImportStateError("native Project root import intent policy is invalid", { cause: error });
    }
    throw error;
  }
  let storedPolicy: StoredImportedRootPolicy;
  try {
    storedPolicy = { policyFormat: "authoritative-v1",
      policy: parseAuthoritativeImportedRootPolicy(parsedPolicy) };
  } catch (authoritativeError) {
    if (result.data.phase !== "root-imported") {
      throw new NativeProjectRootImportStateError("legacy native Project root import intent is incomplete", {
        cause: authoritativeError
      });
    }
    try {
      storedPolicy = { policyFormat: "legacy-import-only", policy: parseLegacyImportedRootPolicy(parsedPolicy) };
    } catch (legacyError) {
      throw new NativeProjectRootImportStateError("native Project root import intent policy is invalid", {
        cause: legacyError
      });
    }
  }
  const policyJson = JSON.stringify(storedPolicy.policy);
  const policyDigest = createHash("sha256").update(policyJson, "utf8").digest("hex");
  if (result.data.protectedRef !== storedPolicy.policy.protectedRef || result.data.policyJson !== policyJson
    || result.data.policyDigest !== policyDigest) {
    throw new NativeProjectRootImportStateError("native Project root import intent policy binding is invalid");
  }
  if (result.data.phase === "intent") {
    if (result.data.bundleDigest !== null || result.data.bundleSize !== null) {
      throw new NativeProjectRootImportStateError("native Project root import phase binding is invalid");
    }
    if (result.data.resolvedTree !== null) {
      throw new NativeProjectRootImportStateError("native Project root import phase binding is invalid");
    }
    return { ...result.data, ...storedPolicy, policyDigest, bundleDigest: null, bundleSize: null,
      resolvedTree: null, phase: "intent" };
  }
  if (result.data.bundleDigest === null || result.data.bundleSize === null) {
    throw new NativeProjectRootImportStateError("native Project root import phase binding is invalid");
  }
  if (result.data.phase === "bundle-durable" || result.data.phase === "installing") {
    if (result.data.resolvedTree !== null) {
      throw new NativeProjectRootImportStateError("native Project root import phase binding is invalid");
    }
    return { ...result.data, ...storedPolicy, policyDigest, bundleDigest: result.data.bundleDigest,
      bundleSize: result.data.bundleSize, resolvedTree: null, phase: result.data.phase };
  }
  if (result.data.resolvedTree === null) {
    throw new NativeProjectRootImportStateError("native Project root import phase binding is invalid");
  }
  return { ...result.data, ...storedPolicy, policyDigest, bundleDigest: result.data.bundleDigest,
    bundleSize: result.data.bundleSize, resolvedTree: result.data.resolvedTree, phase: result.data.phase };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class NativeProjectRootImportStateError extends Error {
  readonly name = "NativeProjectRootImportStateError";
}
export class NativeProjectRootImportConflictError extends Error {
  readonly name = "NativeProjectRootImportConflictError";
  constructor(readonly projectId: string) {
    super(`native Project '${projectId}' root import intent conflicts with durable state`);
  }
}
export class NativeProjectRootImportOwnershipError extends Error {
  readonly name = "NativeProjectRootImportOwnershipError";
  constructor() {
    super("native Project root import host does not own the registered Project");
  }
}
