import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isScalar, parseDocument, visit } from "yaml";
import { nativeQemuDescriptorDigest, type NativeQemuDescriptor } from "./nativeQemuAssignment.js";
import {
  NativeHostVerificationError,
  type NativeCandidateJob,
  type NativeCandidateReadAuthority
} from "./nativeOrdinaryCandidateVerifier.js";

export type NativeQemuCandidateVerificationInput = {
  readonly authority: NativeCandidateReadAuthority;
  readonly descriptor: NativeQemuDescriptor;
  readonly descriptorDigest: string;
  readonly workspace: string;
  readonly scriptFile: string;
  readonly signal: AbortSignal;
};

export async function verifyAndMaterializeNativeQemuCandidate(
  input: NativeQemuCandidateVerificationInput
): Promise<void> {
  if (nativeQemuDescriptorDigest(input.descriptor) !== input.descriptorDigest) {
    throw new NativeHostVerificationError("claim descriptor digest does not match its descriptor");
  }
  const descriptor = input.descriptor;
  const identity = { projectId: descriptor.projectId, repositoryId: descriptor.repositoryId };
  const protectedHead = await input.authority.resolveProtectedHead({
    ...identity, protectedRef: descriptor.protectedRef, signal: input.signal
  });
  if (protectedHead !== descriptor.expectedProtectedHead) {
    throw new NativeHostVerificationError("protected head identity changed");
  }
  const commit = await input.authority.readCommit({
    ...identity, objectId: descriptor.candidateCommit, signal: input.signal
  });
  if (commit.objectId !== descriptor.candidateCommit || commit.treeObjectId !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("candidate commit does not identify the descriptor tree");
  }
  const config = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: ".dim/ci/runner.yml",
    maximumBytes: 64 * 1024, signal: input.signal
  });
  assertBlob(config, descriptor.configBlob, 64 * 1024, "config");
  const job = parseQemuJob(config.bytes, descriptor.jobName);
  if (job.script !== descriptor.script.path || JSON.stringify(job.argv) !== JSON.stringify(descriptor.argv)) {
    throw new NativeHostVerificationError("candidate config does not match the descriptor");
  }
  const script = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: descriptor.script.path,
    maximumBytes: 1024 * 1024, signal: input.signal
  });
  assertBlob(script, descriptor.script, 1024 * 1024, "script");
  const materialized = await input.authority.materializeTree({
    ...identity, commitObjectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree,
    destination: input.workspace, signal: input.signal
  });
  if (materialized.commitObjectId !== descriptor.candidateCommit
    || materialized.treeObjectId !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("materialized candidate identity does not match the descriptor");
  }
  await mkdir(dirname(input.scriptFile), { recursive: true, mode: 0o700 });
  await writeFile(input.scriptFile, script.bytes, { mode: 0o400, flag: "wx" });
  await chmod(input.scriptFile, 0o400);
}

function assertBlob(
  blob: { readonly objectId: string; readonly mode: "100644" | "100755"; readonly bytes: Buffer },
  expected: { readonly objectId: string; readonly sha256: string },
  maximumBytes: number,
  label: string
): void {
  if (blob.bytes.length > maximumBytes || blob.objectId !== expected.objectId
    || digest(blob.bytes) !== expected.sha256) {
    throw new NativeHostVerificationError(`candidate ${label} blob does not match the descriptor`);
  }
}

function parseQemuJob(bytes: Buffer, jobName: string): NativeCandidateJob {
  if (bytes.length > 64 * 1024 || bytes.includes(0)) invalid("bytes are invalid");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) {
    if (error instanceof TypeError) {
      throw new NativeHostVerificationError("candidate config is not UTF-8", { cause: error });
    }
    throw error;
  }
  const document = parseDocument(source, {
    keepSourceTokens: true, merge: false, schema: "core", strict: true, uniqueKeys: true, version: "1.2"
  });
  if (document.errors.length > 0 || document.warnings.length > 0) invalid("is not strict YAML");
  visit(document, {
    Alias() { invalid("contains an alias"); },
    Node(_key, node) { if (node.anchor !== undefined || node.tag !== undefined) invalid("contains YAML metadata"); },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "<<") {
        invalid("contains an invalid mapping key");
      }
    }
  });
  const root = exactRecord(document.toJS({ maxAliasCount: 0 }), ["schemaVersion", "ordinary", "qemu"]);
  if (root.schemaVersion !== 4) invalid("schemaVersion must be 4");
  const ordinary = exactJobs(root.ordinary, "ordinary");
  const qemu = exactJobs(root.qemu, "qemu");
  const names = [...Object.keys(ordinary), ...Object.keys(qemu)];
  if (names.length < 1 || names.length > 64 || new Set(names).size !== names.length) invalid("job sets are invalid");
  const selected = qemu[jobName];
  if (selected === undefined) invalid("QEMU job is missing");
  return selected;
}

function exactJobs(value: unknown, label: string): Readonly<Record<string, NativeCandidateJob>> {
  const jobs = record(exactRecord(value, ["jobs"]).jobs);
  const names = Object.keys(jobs);
  if (names.length > 64 || names.some((name) => !/^[a-z][a-z0-9-]{0,62}$/.test(name))) {
    invalid(`${label} job names are invalid`);
  }
  return Object.fromEntries(names.map((name) => {
    const job = exactRecord(jobs[name], ["script", "argv"]);
    if (typeof job.script !== "string" || !/^\.dim\/ci\/jobs\/[a-z][a-z0-9-]{0,62}\.bash$/.test(job.script)
      || !Array.isArray(job.argv) || JSON.stringify(job.argv) !== JSON.stringify(candidateArgv)) {
      invalid(`${label} job is invalid`);
    }
    return [name, { script: job.script, argv: candidateArgv }];
  }));
}

const candidateArgv = ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"] as const;

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) {
    invalid("has invalid fields");
  }
  return input;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("must contain mappings");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalid(message: string): never {
  throw new NativeHostVerificationError(`candidate config ${message}`);
}
