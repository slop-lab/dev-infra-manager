import path from "node:path";
import { defineConfig } from "vitest/config";
import { FailureOnlyReporter } from "./support/failure-only-reporter.js";

export default defineConfig({
  test: {
    reporters: process.env.DIM_CHECK_VERBOSE === "1" ? ["default"] : [new FailureOnlyReporter()],
    silent: process.env.DIM_CHECK_VERBOSE === "1" ? false : "passed-only",
    // Package fixtures include real Git imports, HTTP services, fsync and
    // restart recovery on shared CI CPUs. This is a harness budget, not a
    // production deadline; explicitly bounded operations retain their limits.
    testTimeout: 15_000
  },
  resolve: {
    alias: {
      "@slop-lab/dim-control-plane/plugin": path.resolve(import.meta.dirname, "../packages/control-plane/core/src/plugin.ts"),
      "@slop-lab/dim-control-plane/lock": path.resolve(import.meta.dirname, "../packages/control-plane/core/src/lock.ts"),
      "@slop-lab/dim-control-plane": path.resolve(import.meta.dirname, "../packages/control-plane/core/src/index.ts"),
      "@slop-lab/dim-plugin-control-plane-native-git/execution": path.resolve(import.meta.dirname, "../packages/control-plane/plugins/native-git/src/execution-protocol.ts"),
      "@slop-lab/dim-plugin-control-plane-native-git/workflow": path.resolve(import.meta.dirname, "../packages/control-plane/plugins/native-git/src/workflowCompiler.ts"),
      "@slop-lab/dim-plugin-control-plane-ci-workflows": path.resolve(import.meta.dirname, "../packages/control-plane/plugins/ci-workflows/src/index.ts"),
      "@slop-lab/dim-plugin-control-plane-native-git/config": path.resolve(import.meta.dirname, "../packages/control-plane/plugins/native-git/src/bundle-config.ts"),
      "@slop-lab/dim-plugin-control-plane-native-git/service": path.resolve(import.meta.dirname, "../packages/control-plane/plugins/native-git/src/service.ts"),
      "@slop-lab/dim-managed/ci": path.resolve(import.meta.dirname, "../core/packages/managed/src/ci/operations.ts"),
      "@slop-lab/dim-managed/cli": path.resolve(import.meta.dirname, "../core/packages/managed/src/cli/managed-cli.ts"),
      "@slop-lab/dim-managed": path.resolve(import.meta.dirname, "../core/packages/managed/src/index.ts"),
      "@slop-lab/dim-core/workspace": path.resolve(import.meta.dirname, "../packages/host/core/src/workspace.ts"),
      "@slop-lab/dim-core": path.resolve(import.meta.dirname, "../packages/host/core/src/index.ts"),
      "@slop-lab/dim-contracts-external-url": path.resolve(
        import.meta.dirname,
        "../packages/contracts/external-url/src/index.ts"
      )
    }
  }
});
