import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dim-contracts-external-url": path.resolve(
        import.meta.dirname,
        "../../dim-contracts/external-url/src/index.ts"
      )
    }
  }
});
