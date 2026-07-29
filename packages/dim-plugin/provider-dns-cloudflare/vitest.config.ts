import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dim-plugin-external-url-contracts": path.resolve(import.meta.dirname, "../external-url-contracts/src/index.ts")
    }
  }
});
