import { defineConfig } from "vitest/config";
import { FailureOnlyReporter } from "./support/failure-only-reporter.js";

export default defineConfig({
  test: {
    reporters: process.env.DIM_CHECK_VERBOSE === "1" ? ["default"] : [new FailureOnlyReporter()],
    silent: process.env.DIM_CHECK_VERBOSE === "1" ? false : "passed-only",
    // Package fixtures include real Git imports, HTTP services, fsync and
    // restart recovery on shared CI CPUs. This is a harness budget, not a
    // production deadline; explicitly bounded operations retain their limits.
    testTimeout: 15_000,
    include: [
      "{host,control-plane,contracts,installer,web,git-review-tracing}/**/*.test.ts",
      "cli/host/**/*.test.ts",
      "scenarios/{harness,execution,llm-router}/**/*.test.ts"
    ],
    exclude: ["**/*.node.test.ts", "scenarios/harness/{qemu*,kvm*,bootstrapInstallerSafety}.test.ts"]
  },
  // Keep linked package SDKs in the same source graph as direct owner imports.
  ssr: {
    resolve: { conditions: ["dim-source", "node"] },
    noExternal: [/^@slop-lab\/dim-/, /^@this-project\/control-plane-deployment/]
  },
  resolve: {
    conditions: ["dim-source"]
  }
});
