#!/usr/bin/env node
import { runRouterCommand } from "./cli.js";
const cancellation = new AbortController();
process.once("SIGINT", () => cancellation.abort());
process.once("SIGTERM", () => cancellation.abort());
try { await runRouterCommand(["llm", ...process.argv.slice(2)], { signal: cancellation.signal }); }
catch (error) { console.error(error instanceof Error ? error.message : "LLM router command failed"); process.exitCode = 1; }
