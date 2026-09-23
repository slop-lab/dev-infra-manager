import { createHash } from "node:crypto";
import { ProtocolError } from "./errors.js";

const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ENTRY_FIELDS = ["path", "kind", "mode", "digest"] as const;
const TREE_FIELDS = ["schemaVersion", "digest", "entries"] as const;
const PROPOSAL_FIELDS = ["schemaVersion", "requestId", "projectId", "workloadId", "tree", "capabilities"] as const;
const POLL_FIELDS = ["schemaVersion", "requestId", "projectId"] as const;

export type TreeEntryKind = "file" | "directory" | "symlink" | "gitlink";

export type TreeEntry = {
  readonly path: string;
  readonly kind: TreeEntryKind;
  readonly mode: string;
  readonly digest: string;
};

export type ReviewedTree = {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly entries: readonly TreeEntry[];
};

export type ScheduleProposal = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly projectId: string;
  readonly workloadId: string;
  readonly tree: ReviewedTree;
  readonly capabilities: readonly string[];
};

export type BrokerPollRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly projectId: string;
};

export function parseBrokerPollRequest(value: unknown): BrokerPollRequest {
  const record = exactRecord(value, POLL_FIELDS, "broker poll request");
  schema(record.schemaVersion, "broker poll request");
  return {
    schemaVersion: 1,
    requestId: identifier(record.requestId, "requestId"),
    projectId: identifier(record.projectId, "projectId")
  };
}

export function parseScheduleProposal(value: unknown): ScheduleProposal {
  const record = exactRecord(value, PROPOSAL_FIELDS, "schedule proposal");
  schema(record.schemaVersion, "schedule proposal");
  if (!Array.isArray(record.capabilities)) throw new ProtocolError("capabilities must be an array");
  return {
    schemaVersion: 1,
    requestId: identifier(record.requestId, "requestId"),
    projectId: identifier(record.projectId, "projectId"),
    workloadId: identifier(record.workloadId, "workloadId"),
    tree: parseReviewedTree(record.tree),
    capabilities: record.capabilities.map((entry) => identifier(entry, "capability"))
  };
}

export function parseReviewedTree(value: unknown): ReviewedTree {
  const record = exactRecord(value, TREE_FIELDS, "reviewed tree");
  schema(record.schemaVersion, "reviewed tree");
  if (!Array.isArray(record.entries)) throw new ProtocolError("reviewed tree entries must be an array");
  const entries = record.entries.map(parseTreeEntry);
  const digest = sha256(record.digest, "tree digest");
  if (treeDigest(entries) !== digest) throw new ProtocolError("reviewed tree digest does not match its complete entry set");
  return { schemaVersion: 1, digest, entries };
}

export function treeDigest(entries: readonly TreeEntry[]): string {
  const canonical = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, kind, mode, digest }) => `${path}\0${kind}\0${mode}\0${digest}\n`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

function parseTreeEntry(value: unknown): TreeEntry {
  const record = exactRecord(value, ENTRY_FIELDS, "tree entry");
  const entryPath = text(record.path, "tree entry path");
  if (entryPath === ".gitmodules" || entryPath.includes("/../") || entryPath.startsWith("../")
    || entryPath.startsWith("/") || entryPath.includes("\\") || entryPath.endsWith("/..")) {
    throw new ProtocolError(`tree entry path '${entryPath}' is forbidden`);
  }
  const kind = treeEntryKind(record.kind);
  return {
    path: entryPath,
    kind,
    mode: text(record.mode, "tree entry mode"),
    digest: sha256(record.digest, "tree entry digest")
  };
}

function treeEntryKind(value: unknown): TreeEntryKind {
  switch (value) {
    case "file": case "directory": case "symlink": case "gitlink": return value;
    default: throw new ProtocolError("tree entry kind is invalid");
  }
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new ProtocolError(`${label} must be an object`);
  }
  const record = value;
  const unknown = Object.keys(record).find((field) => !fields.includes(field));
  if (unknown !== undefined) throw new ProtocolError(`${label} contains forbidden field '${unknown}'`);
  const missing = fields.find((field) => record[field] === undefined);
  if (missing !== undefined) throw new ProtocolError(`${label}.${missing} is required`);
  return record;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schema(value: unknown, label: string): asserts value is 1 {
  if (value !== 1) {
    throw new ProtocolError(`${label} uses unsupported schema ${String(value)}; expected 1`);
  }
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!IDENTIFIER.test(parsed)) throw new ProtocolError(`${label} is invalid`);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SHA256.test(parsed)) throw new ProtocolError(`${label} must be a lowercase SHA-256 digest`);
  return parsed;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError(`${label} must be a non-empty string`);
  return value;
}
