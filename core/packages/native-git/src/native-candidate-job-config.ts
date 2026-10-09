import { isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
import {
  candidateArgv,
  CandidateExecutionError,
  type CandidateJob
} from "./candidate-execution-schema.js";

const jobNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const scriptPathSchema = z.string().regex(/^\.dim\/ci\/jobs\/[a-z][a-z0-9-]{0,62}\.bash$/);
const executionKindSchema = z.enum(["ordinary-sysbox", "qemu"]);

const jobSchema = z.object({
  script: scriptPathSchema,
  argv: z.tuple([
    z.literal(candidateArgv[0]),
    z.literal(candidateArgv[1]),
    z.literal(candidateArgv[2]),
    z.literal(candidateArgv[3])
  ]).readonly()
}).strict().readonly();

const jobGroupSchema = z.object({
  jobs: z.record(jobNameSchema, jobSchema)
}).strict().readonly();

const configSchema = z.object({
  schemaVersion: z.literal(4),
  ordinary: jobGroupSchema,
  qemu: jobGroupSchema
}).strict().readonly();

const requiredJobSchema = z.object({
  name: jobNameSchema,
  kind: executionKindSchema
}).strict().readonly();

const requiredJobsSchema = z.array(requiredJobSchema).min(1).max(64).readonly();

export type NativeCandidateRequiredJob = z.infer<typeof requiredJobSchema>;

export type NativeCandidateJobPlanEntry = NativeCandidateRequiredJob & CandidateJob;

export type NativeCandidateJobConfig = {
  readonly schemaVersion: 4;
  readonly ordinary: { readonly jobs: Readonly<Record<string, CandidateJob>> };
  readonly qemu: { readonly jobs: Readonly<Record<string, CandidateJob>> };
  readonly plan: readonly NativeCandidateJobPlanEntry[];
};

export function parseNativeCandidateJobConfig(
  bytes: Buffer,
  requiredJobs: readonly NativeCandidateRequiredJob[]
): NativeCandidateJobConfig {
  const required = requiredJobsSchema.safeParse(requiredJobs);
  if (!required.success) {
    throw new CandidateExecutionError("native required jobs are invalid", { cause: required.error });
  }
  const requiredNames = required.data.map(({ name }) => name);
  if (new Set(requiredNames).size !== requiredNames.length) {
    throw new CandidateExecutionError("native required jobs must have distinct names");
  }

  const parsed = configSchema.safeParse(parseStrictYaml(bytes));
  if (!parsed.success) {
    throw new CandidateExecutionError("native candidate runner config has an invalid schema", { cause: parsed.error });
  }
  const ordinaryJobs = canonicalJobs(parsed.data.ordinary.jobs);
  const qemuJobs = canonicalJobs(parsed.data.qemu.jobs);
  const ordinaryNames = Object.keys(ordinaryJobs);
  const qemuNames = Object.keys(qemuJobs);
  if (ordinaryNames.some((name) => Object.hasOwn(qemuJobs, name))) {
    throw new CandidateExecutionError("native candidate runner job names overlap across execution kinds");
  }

  const requiredOrdinary = required.data
    .filter(({ kind }) => kind === "ordinary-sysbox")
    .map(({ name }) => name)
    .sort();
  const requiredQemu = required.data
    .filter(({ kind }) => kind === "qemu")
    .map(({ name }) => name)
    .sort();
  assertExactJobSet(ordinaryNames, requiredOrdinary, "ordinary-sysbox");
  assertExactJobSet(qemuNames, requiredQemu, "qemu");

  const ordinaryPlan = Object.entries(ordinaryJobs).map(([name, job]) => ({
    name, kind: "ordinary-sysbox" as const, script: job.script, argv: candidateArgv
  }));
  const qemuPlan = Object.entries(qemuJobs).map(([name, job]) => ({
    name, kind: "qemu" as const, script: job.script, argv: candidateArgv
  }));
  return {
    schemaVersion: 4,
    ordinary: { jobs: ordinaryJobs },
    qemu: { jobs: qemuJobs },
    plan: [...ordinaryPlan, ...qemuPlan]
  };
}

function parseStrictYaml(bytes: Buffer): unknown {
  if (bytes.length > 64 * 1024) {
    throw new CandidateExecutionError("native candidate runner config exceeds 64 KiB");
  }
  if (bytes.includes(0)) {
    throw new CandidateExecutionError("native candidate runner config contains NUL");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CandidateExecutionError("native candidate runner config is not UTF-8", { cause: error });
    }
    throw error;
  }
  const document = parseDocument(source, {
    keepSourceTokens: true,
    merge: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
    version: "1.2"
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new CandidateExecutionError("native candidate runner config is not strict YAML");
  }
  visit(document, {
    Alias() {
      throw new CandidateExecutionError("native candidate runner config contains an alias");
    },
    Node(_key, node) {
      if (node.anchor !== undefined) {
        throw new CandidateExecutionError("native candidate runner config contains an anchor");
      }
      if (node.tag !== undefined) {
        throw new CandidateExecutionError("native candidate runner config contains an explicit tag");
      }
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new CandidateExecutionError("native candidate runner config contains a non-string mapping key");
      }
      if (pair.key.value === "<<") {
        throw new CandidateExecutionError("native candidate runner config contains a merge key");
      }
    }
  });
  return document.toJS({ maxAliasCount: 0 });
}

function canonicalJobs(jobs: Readonly<Record<string, CandidateJob>>): Readonly<Record<string, CandidateJob>> {
  return Object.fromEntries(Object.entries(jobs).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function assertExactJobSet(actual: readonly string[], required: readonly string[], kind: string): void {
  if (actual.length !== required.length || actual.some((name, index) => name !== required[index])) {
    throw new CandidateExecutionError(`native candidate ${kind} jobs do not equal the protected policy job set`);
  }
}
