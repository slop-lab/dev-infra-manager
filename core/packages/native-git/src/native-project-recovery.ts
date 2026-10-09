import type { NativeGitBundleState } from "./native-bundle-state.js";
import {
  completeNativeProjectPreparation,
  readNativeProjectRegistrationsFromDatabase,
  type NativeProjectRegistration
} from "./native-project-registry-state.js";
import {
  assertOwnedNativeProjectStorage,
  prepareOwnedNativeProjectStorage
} from "./native-project-storage.js";
import {
  assertRegisteredRepository,
  initializeNativeRepository
} from "./repository.js";

type NativeProjectRecovery = {
  readonly state: NativeGitBundleState;
  readonly config: Parameters<typeof initializeNativeRepository>[0];
  readonly generationId: string;
  readonly registrations: readonly NativeProjectRegistration[];
  readonly activated: boolean;
};

export async function recoverNativeProjectProvisioning(
  input: NativeProjectRecovery
): Promise<readonly NativeProjectRegistration[]> {
  for (const registration of input.registrations) {
    const repository = { projectId: registration.projectId, repositoryId: registration.rootRepositoryId };
    if (registration.phase === "root-prepared") {
      await assertOwnedNativeProjectStorage(input.config.storageRoot, registration);
      await assertRegisteredRepository(input.config, repository);
    } else if (input.activated) {
      await prepareOwnedNativeProjectStorage(input.config.storageRoot, registration);
      await initializeNativeRepository(input.config, repository);
      completeNativeProjectPreparation(input.state.database, input.generationId, registration.projectId);
    }
  }
  return readNativeProjectRegistrationsFromDatabase(input.state.database);
}
