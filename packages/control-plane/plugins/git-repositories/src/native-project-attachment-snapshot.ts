import type { LiveImportedRoot } from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { readEffectiveRepositoryPolicy } from "./repository-policy-state.js";
import { readNativeProjectRootCurrentHeadFromDatabase } from "./repository-ref-state.js";

export function assertCurrentNativeProjectAttachmentSnapshot(input: {
  readonly database: string;
  readonly verified: readonly LiveImportedRoot[];
}): void {
  const first = input.verified[0];
  if (first === undefined) throw new NativeProjectRootImportStateError("native Project attachment is empty");
  const imports = readNativeProjectRootImportsFromDatabase(input.database);
  const currentRepositoryIds = imports.filter((entry) => entry.ownerHostId === first.imported.ownerHostId
    && entry.projectId === first.imported.projectId && entry.phase === "repository-imported")
    .map((entry) => entry.repositoryId);
  const verifiedRepositoryIds = input.verified.map((root) => root.imported.repositoryId);
  if (JSON.stringify(currentRepositoryIds) !== JSON.stringify(verifiedRepositoryIds)) {
    throw new NativeProjectRootImportStateError("native Project attachment repository set changed during verification");
  }
  for (const root of input.verified) {
    const receipt = imports.find((entry) => entry.projectId === root.importReceipt.projectId
      && entry.repositoryId === root.importReceipt.repositoryId);
    const effective = readEffectiveRepositoryPolicy(
      input.database,
      root.importReceipt.projectId,
      root.importReceipt.repositoryId
    );
    const head = readNativeProjectRootCurrentHeadFromDatabase(
      input.database,
      root.importReceipt.projectId,
      root.importReceipt.repositoryId
    );
    if (JSON.stringify(receipt) !== JSON.stringify(root.importReceipt)
      || JSON.stringify(effective.policy) !== JSON.stringify(root.imported.policy)
      || effective.policyDigest !== root.imported.policyDigest
      || JSON.stringify(head) !== JSON.stringify(root.currentHead)) {
      throw new NativeProjectRootImportStateError("native Project attachment changed during verification");
    }
  }
}
