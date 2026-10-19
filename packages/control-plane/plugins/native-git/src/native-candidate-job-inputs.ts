import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertCandidateObjects,
  candidatePathExists,
  type CandidateGitReader,
  type CandidateObjectTuple,
  readCandidateBlob
} from "./candidate-execution-git.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";
import { isCandidatePath, isCandidateArgv, type WorkflowCompiler, type NativeCandidateRequiredJob } from "./workflowCompiler.js";

export type NativeCandidateBlobIdentity = {
  readonly objectId: string;
  readonly sha256: string;
};

export type NativeCandidateScriptIdentity = NativeCandidateBlobIdentity & {
  readonly path: string;
};

export type NativeCandidateJobInputPlanEntry = NativeCandidateRequiredJob & {
  readonly script: NativeCandidateScriptIdentity;
  readonly argv: readonly string[];
  readonly repositories: readonly string[];
};

export type NativeCandidateJobInputs = {
  readonly configBlob: NativeCandidateScriptIdentity | null;
  readonly plan: readonly NativeCandidateJobInputPlanEntry[];
};

export async function readNativeCandidateJobInputsFromGit(
  reader: CandidateGitReader,
  target: CandidateObjectTuple,
  compiler: WorkflowCompiler
): Promise<NativeCandidateJobInputs> {
  await assertCandidateObjects(reader, target);
  const configurationPath = compiler.configurationPath;
  if (!isCandidatePath(configurationPath)) throw new CandidateExecutionError("workflow configuration path is invalid");
  if (!await candidatePathExists(reader, target.candidateTree, configurationPath)) {
    await assertCandidateObjects(reader, target);
    return { configBlob: null, plan: [] };
  }
  const configBlob = await readCandidateBlob(reader, target.candidateTree, configurationPath, 64 * 1024);
  const compiled = z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    kind: z.enum(["ordinary-sysbox", "qemu"]),
    script: z.string().refine(isCandidatePath),
    repositories: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)).max(64).refine((ids) => new Set(ids).size === ids.length).optional(),
    argv: z.array(z.string()).refine(isCandidateArgv)
  }).strict()).max(64).parse(compiler.compile(configBlob.bytes));
  if (new Set(compiled.map((job) => job.name)).size !== compiled.length) {
    throw new CandidateExecutionError("compiled workflow job names must be unique");
  }
  const plan: NativeCandidateJobInputPlanEntry[] = [];
  for (const job of compiled.sort((left, right) => left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name))) {
    const scriptBlob = await readCandidateBlob(reader, target.candidateTree, job.script, 1024 * 1024);
    plan.push({
      name: job.name,
      kind: job.kind,
      script: { path: job.script, objectId: scriptBlob.objectId, sha256: sha256(scriptBlob.bytes) },
      argv: job.argv, repositories: job.repositories ?? []
    });
  }
  await assertCandidateObjects(reader, target);
  return {
    configBlob: { path: configurationPath, objectId: configBlob.objectId, sha256: sha256(configBlob.bytes) },
    plan
  };
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
