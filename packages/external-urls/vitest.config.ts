import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dev-infra-manager-core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
      "@slop-lab/dim-external-url-contracts": path.resolve(import.meta.dirname, "../external-url-contracts/src/index.ts")
    }
  }
});
