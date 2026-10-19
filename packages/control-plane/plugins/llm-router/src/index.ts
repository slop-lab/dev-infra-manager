import { once } from "node:events";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin";
import { loadConfig } from "./config.js";
import { createRouter } from "./server.js";

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "llm-router",
  async configure(raw) {
    if (typeof raw !== "string") throw new Error("LLM router plugin configuration must be a private config filename");
    const config = await loadConfig(raw);
    return { async start({ signal }) {
      const router = await createRouter(config);
      try { signal.throwIfAborted(); router.server.listen(config.listen); await once(router.server, "listening", { signal }); }
      catch (error) { await router.close(); throw error; }
      return { close: () => router.close() };
    } };
  }
};
export { createRouter } from "./server.js";
export { parseConfig, loadConfig, defaultLimits } from "./config.js";
export { RouterLedger } from "./ledger.js";
