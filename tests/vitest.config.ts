import path from "node:path";
import { defineConfig } from "vitest/config";
import sourceConfig from "../tsconfig.source.json" with { type: "json" };
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
      "{host,control-plane,contracts,installer,web}/**/*.test.{ts,mjs}",
      "cli/host/**/*.test.ts",
      "scenarios/{harness,ci,llm-router}/**/*.test.{ts,mjs}"
    ],
    exclude: ["scenarios/harness/{qemu*,kvm*,bootstrapInstallerSafety}.test.ts"]
  },
  resolve: {
    alias: Object.entries(sourceConfig.compilerOptions.paths)
      .sort(([a], [b]) => b.length - a.length)
      .map(([find, [source]]) => ({ find, replacement: path.resolve(import.meta.dirname, "..", source!) }))
  }
});
