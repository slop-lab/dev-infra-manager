import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@slop-lab/dim-dns-provider-cloudflare": path.resolve(
        import.meta.dirname,
        "../../dns-provider/cloudflare/src/index.ts"
      )
    }
  }
});
