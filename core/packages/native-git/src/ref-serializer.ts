export type RefSerializer = {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
};

export function createRefSerializer(): RefSerializer {
  const tails = new Map<string, Promise<void>>();
  return {
    async run(key, operation) {
      const previous = tails.get(key) ?? Promise.resolve();
      let release: (() => void) | undefined;
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(key, current);
      await previous;
      try {
        return await operation();
      } finally {
        release?.();
        if (tails.get(key) === current) tails.delete(key);
      }
    }
  };
}

export function refSerializationKey(projectId: string, repositoryId: string, protectedRef: string): string {
  return `${projectId}/${repositoryId}/${protectedRef}`;
}
