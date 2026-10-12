import { createHash } from "node:crypto";
import { z } from "zod";
import type { NativeGitServiceConfig } from "./config.js";
import {
  assertCandidateObjects,
  candidatePathExists,
  type CandidateGitReader,
  type CandidateObjectTuple,
  openCandidateGitReader,
  readCandidateBlob
} from "./candidate-execution-git.js";
import { candidateArgv, CandidateExecutionError } from "./candidate-execution-schema.js";
import { parseNativeCandidateJobConfig, type NativeCandidateRequiredJob } from "./native-candidate-job-config.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const protectedRef = z.string().max(1024).refine((value) => safeHeadRef(value));
const requestSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  protectedRef,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
}).strict().readonly();

export type NativeCandidateJobInputsRequest = z.infer<typeof requestSchema>;

export type NativeCandidateBlobIdentity = {
  readonly objectId: string;
  readonly sha256: string;
};

export type NativeCandidateScriptIdentity = NativeCandidateBlobIdentity & {
  readonly path: string;
};

export type NativeCandidateJobInputPlanEntry = NativeCandidateRequiredJob & {
  readonly script: NativeCandidateScriptIdentity;
  readonly argv: typeof candidateArgv;
};

export type NativeCandidateJobInputs = {
  readonly configBlob: NativeCandidateBlobIdentity | null;
  readonly plan: readonly NativeCandidateJobInputPlanEntry[];
};

export async function loadNativeCandidateJobInputs(
  config: NativeGitServiceConfig,
  input: unknown
): Promise<NativeCandidateJobInputs> {
  try {
    const request = requestSchema.safeParse(input);
    if (!request.success) {
      throw new CandidateExecutionError("native candidate job input request is invalid", { cause: request.error });
    }
    assertRegisteredTarget(config, request.data);
    const reader = await openCandidateGitReader(config, request.data.projectId, request.data.repositoryId);
    return await readNativeCandidateJobInputsFromGit(reader, request.data);
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("native candidate job inputs could not be loaded", { cause: error });
  }
}

export async function readNativeCandidateJobInputsFromGit(
  reader: CandidateGitReader,
  target: CandidateObjectTuple
): Promise<NativeCandidateJobInputs> {
  await assertCandidateObjects(reader, target);
  if (!await candidatePathExists(reader, target.candidateTree, ".dim/ci/runner.yml")) {
    await assertCandidateObjects(reader, target);
    return { configBlob: null, plan: [] };
  }
  const configBlob = await readCandidateBlob(reader, target.candidateTree, ".dim/ci/runner.yml", 64 * 1024);
  const parsed = parseNativeCandidateJobConfig(configBlob.bytes);
  const plan: NativeCandidateJobInputPlanEntry[] = [];
  for (const job of parsed.plan) {
    const scriptBlob = await readCandidateBlob(reader, target.candidateTree, job.script, 1024 * 1024);
    plan.push({
      name: job.name,
      kind: job.kind,
      script: { path: job.script, objectId: scriptBlob.objectId, sha256: sha256(scriptBlob.bytes) },
      argv: candidateArgv
    });
  }
  await assertCandidateObjects(reader, target);
  return {
    configBlob: { objectId: configBlob.objectId, sha256: sha256(configBlob.bytes) },
    plan
  };
}

function assertRegisteredTarget(config: NativeGitServiceConfig, request: NativeCandidateJobInputsRequest): void {
  const repository = config.repositories.find((candidate) =>
    candidate.projectId === request.projectId && candidate.repositoryId === request.repositoryId
  );
  const policy = repository?.reviewPolicies?.find((candidate) => candidate.protectedRef === request.protectedRef);
  if (policy === undefined) {
    throw new CandidateExecutionError("native candidate job inputs do not match a registered repository policy");
  }
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.startsWith("refs/heads/proposals/")
    || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\")
    || /[\x00-\x20\x7f~^:?*[\]]/.test(value)) return false;
  return value.slice("refs/heads/".length).split("/")
    .every((component) => component.length > 0 && !component.startsWith("."));
}
