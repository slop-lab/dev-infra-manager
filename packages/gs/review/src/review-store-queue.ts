import { resolve } from "node:path";

const settled = Promise.resolve();
const repositoryTails = new Map<string, Promise<void>>();

export function runReviewStoreOperation<Result>(
  repository: string,
  operation: (repositoryKey: string) => Promise<Result>,
): Promise<Result> {
  const repositoryKey = resolve(repository);
  const preceding = repositoryTails.get(repositoryKey) ?? settled;
  const result = preceding.then(() => operation(repositoryKey));
  const tail = result.then(() => undefined, () => undefined);
  repositoryTails.set(repositoryKey, tail);
  void tail.then(() => {
    if (repositoryTails.get(repositoryKey) === tail) repositoryTails.delete(repositoryKey);
  });
  return result;
}
