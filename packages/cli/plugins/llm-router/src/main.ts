#!/usr/bin/env node
import { runLlmRouterCommand } from "./index.js";
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort); process.once("SIGTERM", abort);
try { await runLlmRouterCommand(["llm-router", ...process.argv.slice(2)], controller.signal); }
catch (error) { console.error(error instanceof Error ? error.message : "LLM router operation failed"); process.exitCode = 1; }
finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
