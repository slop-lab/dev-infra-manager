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
      "@slop-lab/dim-native-git/workflow": path.resolve(import.meta.dirname, "../core/packages/native-git/src/workflowCompiler.ts"),
      "@slop-lab/dim-plugin-ci-workflows": path.resolve(import.meta.dirname, "../plugin-ci-workflows/src/index.ts"),
      "@slop-lab/dim-native-git/service": path.resolve(import.meta.dirname, "../core/packages/native-git/src/service.ts"),
      "@slop-lab/dim-managed/cli": path.resolve(import.meta.dirname, "../core/packages/managed/src/cli/managed-cli.ts"),
      "@slop-lab/dim-managed": path.resolve(import.meta.dirname, "../core/packages/managed/src/index.ts"),
      "@slop-lab/dim-core/workspace": path.resolve(import.meta.dirname, "../core/packages/core/src/workspace.ts"),
      "@slop-lab/dim-core": path.resolve(import.meta.dirname, "../core/packages/core/src/index.ts"),
      "@slop-lab/dim-contracts-external-url": path.resolve(
        import.meta.dirname,
        "../core/packages/contracts/external-url/src/index.ts"
      )
    }
  }
});
