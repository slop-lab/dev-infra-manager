import path from "node:path";
import { defineConfig } from "vitest/config";

const config = defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dim-core": path.resolve(import.meta.dirname, "../core/packages/core/src/index.ts"),
      "@slop-lab/dim-contracts-external-url": path.resolve(
        import.meta.dirname,
        "../core/packages/contracts/external-url/src/index.ts"
      )
    }
  }
});

export default config;
