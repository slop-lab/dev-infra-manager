import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scenarios/web-lifecycle/*.test.ts"],
    fileParallelism: false
  }
});
