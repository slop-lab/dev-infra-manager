import { z } from "zod";
import {
  beginNativeProjectPreparation,
  completeNativeProjectPreparation
} from "./native-project-registry-state.js";
import {
  assertOwnedNativeProjectStorage,
  prepareOwnedNativeProjectStorage
} from "./native-project-storage.js";
import { assertRegisteredRepository, initializeNativeRepository } from "./repository.js";

type RegistrationOperation = {
  readonly database: string;
  readonly stateDirectory: string;
  readonly runtimeConfig: {
    readonly storageRoot: string;
    readonly gitExecutable: string;
    readonly gitVersion: string;
  };
  readonly generationId: string;
  readonly ownerHostId: string;
  readonly input: unknown;
};

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const preparationInput = z.object({
  serviceId: z.literal("native-main"),
  projectId: identifier,
  rootRepositoryId: z.literal("root")
}).strict().readonly();

export type NativeProjectPreparationInput = z.infer<typeof preparationInput>;

export type NativeGitProjectPreparationResult = NativeProjectPreparationInput & {
  readonly state: "root-prepared";
};

export async function executeNativeProjectPreparation(
  operation: RegistrationOperation
): Promise<NativeGitProjectPreparationResult> {
  const requested = parseNativeProjectPreparationInput(operation.input);
  const begun = beginNativeProjectPreparation(operation.database, operation.generationId, {
    serviceId: requested.serviceId,
    projectId: requested.projectId,
    rootRepositoryId: requested.rootRepositoryId,
    ownerHostId: operation.ownerHostId
  });
  const repository = { projectId: begun.projectId, repositoryId: begun.rootRepositoryId };
  if (begun.phase === "root-prepared") {
    await assertOwnedNativeProjectStorage(operation.stateDirectory, begun);
    await assertRegisteredRepository(operation.runtimeConfig, repository);
  } else {
    await prepareOwnedNativeProjectStorage(operation.stateDirectory, begun);
    await initializeNativeRepository(operation.runtimeConfig, repository);
    completeNativeProjectPreparation(operation.database, operation.generationId, begun.projectId);
  }
  return {
    serviceId: requested.serviceId,
    projectId: requested.projectId,
    rootRepositoryId: requested.rootRepositoryId,
    state: "root-prepared"
  };
}

export function parseNativeProjectPreparationInput(input: unknown): NativeProjectPreparationInput {
  const result = preparationInput.safeParse(input);
  if (!result.success) {
    throw new NativeGitProjectRegistrationError("native Project preparation is invalid", { cause: result.error });
  }
  return result.data;
}

export class NativeGitProjectRegistrationError extends Error {
  readonly name = "NativeGitProjectRegistrationError";
}
