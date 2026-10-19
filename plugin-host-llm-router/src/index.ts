import type { WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";
import { runLlmCommand } from "./cli.js";
export const hostPlugin: WorkspaceHostPlugin = { name: "host-llm-router", commands: [
  { name: "llm", description: "Connect a host gateway and attach workspaces to control-plane LLM routing" }
], run: runLlmCommand };
export { createHostGateway } from "./gateway.js";
export { parseHostConfig, loadHostConfig } from "./config.js";
