import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dim-core": path.resolve(import.meta.dirname, "../../core/src/index.ts"),
      "@slop-lab/dim-contracts-external-url": path.resolve(
        import.meta.dirname,
        "../../contracts/external-url/src/index.ts"
      ),
      "@slop-lab/dim-ingress-caddy": path.resolve(import.meta.dirname, "../../ingress/caddy/src/index.ts")
    }
  }
});
