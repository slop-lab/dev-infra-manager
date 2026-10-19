import { configDefaults, defineConfig } from "vitest/config";
import { FailureOnlyReporter } from "../tests/support/failure-only-reporter.js";

export default defineConfig({
  test: {
    reporters: process.env.DIM_CHECK_VERBOSE === "1" ? ["default"] : [new FailureOnlyReporter()],
    silent: process.env.DIM_CHECK_VERBOSE === "1" ? false : "passed-only",
    exclude: [...configDefaults.exclude, "live/**"]
  }
});
