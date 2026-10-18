import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Package fixtures include real Git imports, HTTP services, fsync and
    // restart recovery on shared CI CPUs. This is a harness budget, not a
    // production deadline; explicitly bounded operations retain their limits.
    testTimeout: 15_000
  },
  resolve: {
    alias: {
      "@slop-lab/dim-core/workspace": path.resolve(import.meta.dirname, "../core/packages/core/src/workspace.ts"),
      "@slop-lab/dim-core": path.resolve(import.meta.dirname, "../core/packages/core/src/index.ts"),
      "@slop-lab/dim-contracts-external-url": path.resolve(
        import.meta.dirname,
        "../core/packages/contracts/external-url/src/index.ts"
      )
    }
  }
});
