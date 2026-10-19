import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export function createTemporaryRootTracker() {
  const temporaryRoots: string[] = [];

  return {
    cleanup: async (): Promise<void> => {
      await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
    create: async (): Promise<string> => {
      const root = await mkdtemp(resolve(tmpdir(), "dim-cache-routing-test-"));
      temporaryRoots.push(root);
      return root;
    }
  } as const;
}
