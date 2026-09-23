import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AdmissionError, ProtocolError } from "./errors.js";
import type { ScheduleProposal } from "./protocol.js";

const APPROVAL_FIELDS = [
  "schemaVersion", "projectId", "treeDigest", "pathPatterns", "capabilityCeiling", "approvedAt", "approvedBy"
] as const;

export type ApprovedTree = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly treeDigest: string;
  readonly pathPatterns: readonly string[];
  readonly capabilityCeiling: readonly string[];
  readonly approvedAt: string;
  readonly approvedBy: string;
};

export type AdmittedWorkload = {
  readonly projectId: string;
  readonly workloadId: string;
  readonly treeDigest: string;
};

export class ApprovalAuthority {
  constructor(readonly root: string) {}

  async approve(approval: ApprovedTree): Promise<void> {
    validateApproval(approval);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.approvalPath(approval.projectId);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async admit(proposal: ScheduleProposal): Promise<AdmittedWorkload> {
    const approval = await this.read(proposal.projectId);
    if (approval.treeDigest !== proposal.tree.digest) {
      throw new AdmissionError("remote proposal tree digest was not explicitly approved");
    }
    const forbiddenEntry = proposal.tree.entries.find((entry) =>
      entry.kind === "symlink" || entry.kind === "gitlink" || entry.path === ".gitmodules");
    if (forbiddenEntry !== undefined) {
      throw new ProtocolError(`reviewed tree contains forbidden ${forbiddenEntry.kind} entry '${forbiddenEntry.path}'`);
    }
    const outsideScope = proposal.tree.entries.find((entry) =>
      !approval.pathPatterns.some((pattern) => pathMatches(pattern, entry.path)));
    if (outsideScope !== undefined) {
      throw new AdmissionError(`tree path '${outsideScope.path}' is outside the approved path patterns`);
    }
    const widened = proposal.capabilities.find((capability) => !approval.capabilityCeiling.includes(capability));
    if (widened !== undefined) throw new AdmissionError(`capability ceiling does not allow '${widened}'`);
    return { projectId: proposal.projectId, workloadId: proposal.workloadId, treeDigest: proposal.tree.digest };
  }

  private async read(projectId: string): Promise<ApprovedTree> {
    const target = this.approvalPath(projectId);
    try {
      if (!(await lstat(target)).isFile()) throw new AdmissionError("approval state must be a regular file");
      return parseApprovedTree(JSON.parse(await readFile(target, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) throw new AdmissionError("approval state is malformed");
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new AdmissionError(`project '${projectId}' has no explicit local operator approval`);
      }
      throw error;
    }
  }

  private approvalPath(projectId: string): string {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(projectId)) throw new ProtocolError("projectId is invalid");
    return path.join(this.root, `${projectId}.json`);
  }
}

export function parseApprovedTree(value: unknown): ApprovedTree {
  if (!isRecord(value)) throw new AdmissionError("approval state is invalid");
  const record = value;
  if (record.schemaVersion !== 1) {
    throw new AdmissionError(
      `approval state uses unsupported schema ${String(record.schemaVersion)}; expected 1. `
      + "export needed data and recreate the approval; DIM will not migrate or delete it"
    );
  }
  const unknown = Object.keys(record).find((field) => !APPROVAL_FIELDS.some((allowed) => allowed === field));
  if (unknown !== undefined) throw new AdmissionError(`approval state contains unknown field '${unknown}'`);
  const approval: ApprovedTree = {
    schemaVersion: 1,
    projectId: requiredText(record.projectId, "projectId"),
    treeDigest: requiredText(record.treeDigest, "treeDigest"),
    pathPatterns: stringArray(record.pathPatterns, "pathPatterns"),
    capabilityCeiling: stringArray(record.capabilityCeiling, "capabilityCeiling"),
    approvedAt: requiredText(record.approvedAt, "approvedAt"),
    approvedBy: requiredText(record.approvedBy, "approvedBy")
  };
  validateApproval(approval);
  return approval;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateApproval(approval: ApprovedTree): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(approval.projectId)) throw new ProtocolError("projectId is invalid");
  if (!/^[0-9a-f]{64}$/.test(approval.treeDigest)) throw new ProtocolError("treeDigest is invalid");
  if (approval.pathPatterns.length === 0) throw new ProtocolError("pathPatterns must not be empty");
  for (const pattern of approval.pathPatterns) {
    if (pattern.startsWith("/") || pattern.includes("..") || pattern.includes("\\")) {
      throw new ProtocolError(`path pattern '${pattern}' is invalid`);
    }
  }
}

function pathMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`).test(candidate);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AdmissionError(`approval ${label} is invalid`);
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new AdmissionError(`approval ${label} is invalid`);
  return value.map((entry) => requiredText(entry, label));
}
