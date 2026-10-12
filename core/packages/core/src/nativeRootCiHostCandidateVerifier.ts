import { isScalar, parseDocument, visit } from "yaml";
import {
  NativeHostVerificationError,
  verifyAndMaterializeCandidate,
  type NativeCandidateJob,
  type NativeCandidateVerificationInput
} from "./nativeOrdinaryCandidateVerifier.js";

export function verifyAndMaterializeNativeRootCiCandidate(
  input: NativeCandidateVerificationInput
): Promise<void> {
  return verifyAndMaterializeCandidate({ ...input, parseJob: parseNativeRootCiCandidateJob });
}

function parseNativeRootCiCandidateJob(bytes: Buffer, jobName: string): NativeCandidateJob {
  if (bytes.length > 64 * 1024 || bytes.includes(0)) invalid("bytes are invalid");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) {
    if (error instanceof TypeError) throw new NativeHostVerificationError("candidate config is not UTF-8", { cause: error });
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
  const ordinaryJobs = exactJobs(root.ordinary, "ordinary");
  const qemuJobs = exactJobs(root.qemu, "qemu");
  const ordinaryNames = Object.keys(ordinaryJobs);
  const qemuNames = Object.keys(qemuJobs);
  if (ordinaryNames.length + qemuNames.length < 1 || ordinaryNames.length + qemuNames.length > 64
    || ordinaryNames.some((name) => Object.hasOwn(qemuJobs, name))) {
    invalid("job sets are invalid");
  }
  const selected = ordinaryJobs[jobName];
  if (selected === undefined) invalid("ordinary job is missing");
  return selected;
}

function exactJobs(value: unknown, label: string): Readonly<Record<string, NativeCandidateJob>> {
  const section = exactRecord(value, ["jobs"]);
  const jobs = record(section.jobs);
  const names = Object.keys(jobs);
  if (names.length > 64 || names.some((name) => !/^[a-z][a-z0-9-]{0,62}$/.test(name))) {
    invalid(`${label} job names are invalid`);
  }
  return Object.fromEntries(names.map((name) => {
    const job = exactRecord(jobs[name], ["script", "argv"]);
    if (typeof job.script !== "string" || !validScriptPath(job.script)
      || !Array.isArray(job.argv) || JSON.stringify(job.argv) !== JSON.stringify(candidateArgv)) {
      invalid(`${label} job is invalid`);
    }
    return [name, { script: job.script, argv: candidateArgv }];
  }));
}

const candidateArgv = ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"] as const;

function validScriptPath(value: string): boolean {
  return /^\.dim\/ci\/jobs\/[a-z][a-z0-9-]{0,62}\.bash$/.test(value);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) invalid("has invalid fields");
  return input;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("must contain mappings");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function invalid(message: string): never {
  throw new NativeHostVerificationError(`candidate config ${message}`);
}
