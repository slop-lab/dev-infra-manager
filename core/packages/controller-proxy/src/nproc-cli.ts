#!/usr/bin/env node
import { runWorkspaceResourcesCli } from "./workspace-resources-cli.js";

const arguments_ = process.argv.slice(2);
void runWorkspaceResourcesCli(arguments_.length === 0 ? ["nproc"] : arguments_)
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
