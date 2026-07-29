import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dev-infra-manager-core": path.resolve(import.meta.dirname, "../../dev-infra-manager/core/src/index.ts"),
      "@slop-lab/dim-plugin-external-url-contracts": path.resolve(import.meta.dirname, "../external-url-contracts/src/index.ts")
    }
  }
});
