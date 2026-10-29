import { z } from "zod";
import { repositorySnapshotsSchema } from "@slop-lab/gs-repository-contracts";

export const executionInputsSchema = repositorySnapshotsSchema;
export type ExecutionInputs = z.infer<typeof executionInputsSchema>;

export class CandidateExecutionError extends Error {
  readonly name = "CandidateExecutionError";
}
