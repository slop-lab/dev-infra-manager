export type RepositoryMutationScope = { readonly projectId: string; readonly repositoryId: string };

export function createRepositoryMutationQueue() {
  let open = true;
  let barrier = Promise.resolve();
  const tails = new Map<string, Promise<void>>();
  return {
    exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
      if (!open) return Promise.reject(new Error("repository service is closed"));
      const result = Promise.all([barrier, ...tails.values()]).then(operation);
      barrier = result.then(() => undefined, () => undefined);
      return result;
    },
    mutate<Result>(scope: RepositoryMutationScope, operation: () => Promise<Result>): Promise<Result> {
      if (!open) return Promise.reject(new Error("repository service is closed"));
      if (![scope.projectId, scope.repositoryId].every((id) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id))) {
        return Promise.reject(new Error("invalid repository mutation scope"));
      }
      const key = `${scope.projectId}/${scope.repositoryId}`;
      const result = Promise.all([barrier, tails.get(key)]).then(operation);
      const settled = result.then(() => undefined, () => undefined);
      tails.set(key, settled);
      void settled.then(() => { if (tails.get(key) === settled) tails.delete(key); });
      return result;
    },
    close(): Promise<void> {
      open = false;
      return Promise.all([barrier, ...tails.values()]).then(() => undefined);
    }
  };
}
