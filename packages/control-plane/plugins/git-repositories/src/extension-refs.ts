import { join } from "node:path";
/** Trusted extensions retain objects without acquiring protected branch authority. */
export type RepositoryOwnedRef = { readonly ref: string; readonly commit: string };
export type RepositoryOwnedRefs = (selector: { readonly projectId: string; readonly repositoryId: string }) => Promise<readonly RepositoryOwnedRef[]>;
export type RepositoryRefOwner = {
  readonly name: string;
  ownedRefs?(stateDirectory: string, selector: { readonly projectId: string; readonly repositoryId: string }): Promise<readonly RepositoryOwnedRef[]>;
};
/** Exact durable ownership declarations are consulted before startup and every live proof. */
export function repositoryOwnedRefs(stateDirectory: string, owners: readonly RepositoryRefOwner[]): RepositoryOwnedRefs {
  return async (selector) => {
    const refs: RepositoryOwnedRef[] = [];
    const names = new Set<string>();
    for (const owner of owners) {
      const declared = await owner.ownedRefs?.(join(stateDirectory, ".extensions", owner.name), selector) ?? [];
      for (const entry of declared) {
        const prefix = `refs/dim/extensions/${owner.name}/`;
        const suffix = entry.ref.startsWith(prefix) ? entry.ref.slice(prefix.length) : "";
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(owner.name) || suffix.length === 0 || suffix.length > 1024
          || !/^[A-Za-z0-9._/-]+$/.test(suffix) || suffix.includes("..") || suffix.includes("//")
          || suffix.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
          || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.commit) || names.has(entry.ref)) throw new Error("Repository extension ref ownership is invalid");
        refs.push(entry); names.add(entry.ref);
      }
    }
    return refs;
  };
}
