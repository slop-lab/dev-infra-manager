import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { isScalar, parseDocument, visit } from "yaml";
import { UserError } from "./errors.js";
import { parseNativeDescriptor } from "./nativeOrdinaryAuthorityModel.js";
import { nativeDescriptorDigest, type NativeOrdinaryDescriptor } from "./nativeOrdinaryAuthorityProtocol.js";

export type NativeCandidateBlob = {
  readonly objectId: string;
  readonly mode: "100644" | "100755";
  readonly bytes: Buffer;
};

export interface NativeCandidateReadAuthority {
  resolveProtectedHead(input: { readonly projectId: string; readonly repositoryId: string; readonly protectedRef: string; readonly signal: AbortSignal }): Promise<string>;
  readCommit(input: { readonly projectId: string; readonly repositoryId: string; readonly objectId: string; readonly signal: AbortSignal }): Promise<{ readonly objectId: string; readonly treeObjectId: string }>;
  readBlob(input: { readonly projectId: string; readonly repositoryId: string; readonly treeObjectId: string; readonly path: string; readonly maximumBytes: number; readonly signal: AbortSignal }): Promise<NativeCandidateBlob>;
  materializeTree(input: { readonly projectId: string; readonly repositoryId: string; readonly commitObjectId: string; readonly treeObjectId: string; readonly destination: string; readonly signal: AbortSignal }): Promise<{ readonly commitObjectId: string; readonly treeObjectId: string }>;
}

type CandidateJob = {
  readonly script: string;
  readonly argv: readonly string[];
};

export async function verifyAndMaterializeCandidate(input: {
  readonly authority: NativeCandidateReadAuthority;
  readonly descriptor: NativeOrdinaryDescriptor;
  readonly descriptorDigest: string;
  readonly workspace: string;
  readonly scriptFile: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  let descriptor: NativeOrdinaryDescriptor;
  try {
    descriptor = parseNativeDescriptor(input.descriptor);
  } catch (error) {
    if (error instanceof UserError) throw new NativeHostVerificationError("claim descriptor is invalid", { cause: error });
    throw error;
  }
  if (nativeDescriptorDigest(descriptor) !== input.descriptorDigest) {
    throw new NativeHostVerificationError("claim descriptor digest does not match its descriptor");
  }
  const identity = { projectId: descriptor.projectId, repositoryId: descriptor.repositoryId };
  const protectedHead = await input.authority.resolveProtectedHead({
    ...identity, protectedRef: descriptor.protectedRef, signal: input.signal
  });
  if (protectedHead !== descriptor.expectedProtectedHead) throw new NativeHostVerificationError("protected head identity changed");
  const commit = await input.authority.readCommit({ ...identity, objectId: descriptor.candidateCommit, signal: input.signal });
  if (commit.objectId !== descriptor.candidateCommit || commit.treeObjectId !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("candidate commit does not identify the descriptor tree");
  }
  const config = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: ".dim/ci/runner.yml", maximumBytes: 64 * 1024,
    signal: input.signal
  });
  assertBlob(config, descriptor.configBlob, 64 * 1024, "config");
  const job = parseCandidateJob(config.bytes, descriptor.jobName);
  if (job.script !== descriptor.script.path || JSON.stringify(job.argv) !== JSON.stringify(descriptor.argv)) {
    throw new NativeHostVerificationError("candidate config does not match the descriptor");
  }
  const script = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: descriptor.script.path, maximumBytes: 1024 * 1024,
    signal: input.signal
  });
  assertBlob(script, descriptor.script, 1024 * 1024, "script");
  const materialized = await input.authority.materializeTree({
    ...identity, commitObjectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree,
    destination: input.workspace, signal: input.signal
  });
  if (materialized.commitObjectId !== descriptor.candidateCommit || materialized.treeObjectId !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("materialized candidate identity does not match the descriptor");
  }
  await writeFile(input.scriptFile, script.bytes, { mode: 0o400, flag: "wx" });
  await chmod(input.scriptFile, 0o400);
}

function assertBlob(
  blob: NativeCandidateBlob,
  expected: { readonly objectId: string; readonly sha256: string },
  maximumBytes: number,
  label: string
): void {
  if ((blob.mode !== "100644" && blob.mode !== "100755") || blob.bytes.length > maximumBytes
    || blob.objectId !== expected.objectId || sha256(blob.bytes) !== expected.sha256) {
    throw new NativeHostVerificationError(`candidate ${label} blob does not match the descriptor`);
  }
}

function parseCandidateJob(bytes: Buffer, jobName: string): CandidateJob {
  if (bytes.length > 64 * 1024 || bytes.includes(0)) throw new NativeHostVerificationError("candidate config bytes are invalid");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new NativeHostVerificationError("candidate config is not UTF-8", { cause: error });
    throw error;
  }
  const document = parseDocument(source, { keepSourceTokens: true, merge: false, schema: "core", strict: true, uniqueKeys: true, version: "1.2" });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new NativeHostVerificationError("candidate config is not strict YAML");
  visit(document, {
    Alias() { throw new NativeHostVerificationError("candidate config contains an alias"); },
    Node(_key, node) {
      if (node.anchor !== undefined || node.tag !== undefined) throw new NativeHostVerificationError("candidate config contains YAML metadata");
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "<<") {
        throw new NativeHostVerificationError("candidate config contains an invalid mapping key");
      }
    }
  });
  return parseConfigValue(document.toJS({ maxAliasCount: 0 }), jobName);
}

function parseConfigValue(value: unknown, jobName: string): CandidateJob {
  const root = exactRecord(value, ["schemaVersion", "ordinary"]);
  if (root.schemaVersion !== 3) throw new NativeHostVerificationError("candidate config schemaVersion must be 3");
  const ordinary = exactRecord(root.ordinary, ["jobs"]);
  const jobs = record(ordinary.jobs);
  const names = Object.keys(jobs);
  if (names.length < 1 || names.length > 64 || names.some((name) => !/^[a-z][a-z0-9-]{0,62}$/.test(name))) {
    throw new NativeHostVerificationError("candidate job names are invalid");
  }
  let selected: CandidateJob | undefined;
  for (const name of names) {
    const job = exactRecord(jobs[name], ["script", "argv"]);
    if (typeof job.script !== "string" || !validScriptPath(job.script)
      || !Array.isArray(job.argv) || JSON.stringify(job.argv) !== JSON.stringify(candidateArgv)) {
      throw new NativeHostVerificationError("candidate job is invalid");
    }
    if (name === jobName) selected = { script: job.script, argv: candidateArgv };
  }
  if (selected === undefined) throw new NativeHostVerificationError("candidate job is missing");
  return selected;
}

const candidateArgv = ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"] as const;
function validScriptPath(value: string): boolean {
  return value.startsWith(".dim/ci/jobs/") && value.endsWith(".bash") && !value.includes("\\")
    && value.split("/").every((component) => component.length > 0 && component !== "." && component !== "..");
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  if (Object.keys(input).length !== keys.length || keys.some((key) => input[key] === undefined)) {
    throw new NativeHostVerificationError("candidate config has invalid fields");
  }
  return input;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeHostVerificationError("candidate config must contain mappings");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class NativeHostVerificationError extends UserError {
  readonly name = "NativeHostVerificationError";
}
