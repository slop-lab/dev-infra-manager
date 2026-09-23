#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import {
  ApprovalAuthority,
  SshBrokerTransport,
  UserError,
  WorkloadRegistryExecutor,
  executeRemoteProposal,
  parseApprovedTree,
  type ApprovedWorkload
} from "@slop-lab/dim-core";
import { readLocalConfig } from "./local-config.js";
import { packageVersion } from "./package-version.js";

const program = new Command()
  .name("dim")
  .description("Local approval and execution authority for isolated DIM workspaces")
  .version(packageVersion)
  .showSuggestionAfterError();

program.command("approve")
  .description("Record explicit local approval from reviewed JSON")
  .requiredOption("--config <path>", "local schema-1 configuration")
  .argument("<approval>", "reviewed approval JSON file")
  .action(async (approvalPath: string, flags: { readonly config: string }) => {
    const config = await readLocalConfig(flags.config);
    const approval = parseApprovedTree(JSON.parse(await readFile(approvalPath, "utf8")));
    await new ApprovalAuthority(config.approvalRoot).approve(approval);
    console.log(JSON.stringify({ approved: true, projectId: approval.projectId, treeDigest: approval.treeDigest }));
  });

program.command("run-remote")
  .description("Poll the pinned SSH broker and run one locally approved workload")
  .requiredOption("--config <path>", "local schema-1 configuration")
  .requiredOption("--request-id <id>", "unique bounded request identifier")
  .argument("<project>", "locally approved Project identifier")
  .action(async (projectId: string, flags: { readonly config: string; readonly requestId: string }) => {
    const config = await readLocalConfig(flags.config);
    const workloads = new Map<string, ApprovedWorkload>(Object.entries(config.workloads).map(([id, command]) => [
      id,
      async () => await runLocalWorkload(command)
    ]));
    const result = await executeRemoteProposal(
      new SshBrokerTransport(config.broker),
      new ApprovalAuthority(config.approvalRoot),
      new WorkloadRegistryExecutor(workloads),
      { schemaVersion: 1, requestId: flags.requestId, projectId }
    );
    process.exitCode = result.exitCode;
  });

program.exitOverride();

try {
  if (process.platform !== "linux") throw new UserError(`DIM requires Linux; unsupported platform '${process.platform}'`);
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code !== "commander.helpDisplayed" && error.code !== "commander.version") {
      process.exitCode = error.exitCode || 2;
    }
  } else if (error instanceof UserError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}

async function runLocalWorkload(command: readonly string[]): Promise<{ readonly exitCode: number }> {
  const executable = command[0];
  if (executable === undefined) throw new UserError("locally configured workload command is empty");
  const child = spawn(executable, command.slice(1), { stdio: "inherit", shell: false, env: process.env });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new UserError(`local workload terminated by ${signal}`));
      else resolve({ exitCode: code ?? 1 });
    });
  });
}
