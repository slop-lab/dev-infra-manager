import { nativeRepositoryBranches, type NativeImportedRootPolicy } from "./native-imported-root-policy.js";

export const conventionalProtectedRefs = ["refs/heads/main", "refs/heads/development"] as const;

export function workspaceProtectedRefs(policy: NativeImportedRootPolicy): readonly string[] {
  return [...new Set([
    ...Object.keys(nativeRepositoryBranches(policy)),
    policy.protectedRef,
    ...conventionalProtectedRefs
  ])].sort();
}
