import type { WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";
import { runLlmCommand } from "./cli.js";
export const hostPlugin: WorkspaceHostPlugin = { name: "llm-router", commands: [
  { name: "llm", description: "Prepare host-owned LLM routing, attach workspaces and inspect usage" }
], run: runLlmCommand };
export { createRouter } from "./server.js";
export { parseConfig, loadConfig, defaultLimits } from "./config.js";
export { RouterLedger } from "./ledger.js";
