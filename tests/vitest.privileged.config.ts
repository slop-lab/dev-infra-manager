import { defineConfig } from "vitest/config";
import ordinary from "./vitest.config.js";

export default defineConfig({
  ...ordinary,
  test: {
    ...ordinary.test,
    include: ["scenarios/harness/{qemu*,kvm*,bootstrapInstallerSafety}.test.ts"],
    exclude: [],
    fileParallelism: false
  }
});
