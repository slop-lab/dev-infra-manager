import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dim-core": path.resolve(import.meta.dirname, "../core/packages/core/src/index.ts")
    }
  }
});
