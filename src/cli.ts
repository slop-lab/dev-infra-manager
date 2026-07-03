#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, writeDefaultConfig } from "./config.js";
import { UserError } from "./errors.js";
import { buildAgentTimeoutArgs, buildAgentTimeoutCommand } from "./docker.js";
import { cleanupJob, prepareJob, readJobMetadata } from "./job.js";
import { ProcessRunner } from "./runner.js";
import { runDoctor } from "./doctor.js";
import {
  approvePullRequest,
  createPullRequest,
  createRepo,
  initGitHost,
  installRepoHooks,
  listPullRequests,
  mergePullRequest,
  readPullRequest
} from "./gitHost.js";
import { deploySecretRuntime } from "./secretDeploy.js";
import { runController } from "./controller.js";
import { runAgentJob } from "./agentJob.js";

interface ParsedArgs {
  command: string[];
  flags: Map<string, string | boolean>;
}

const runner = new ProcessRunner();

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const [command, subcommand] = parsed.command;

  if (!command || parsed.flags.has("help") || parsed.flags.has("h")) {
    printHelp();
    return;
  }

  if (command === "init-config") {
    const output = stringFlag(parsed, "output", "dev-infra.config.json");
    await mkdir(dirname(output), { recursive: true });
    await writeDefaultConfig(output);
    console.log(`Wrote ${output}`);
    return;
  }

  if (command === "doctor") {
    const checks = await runDoctor(runner);
    for (const check of checks) {
      console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
    }
    if (checks.some((check) => !check.ok)) {
      process.exitCode = 1;
    }
    return;
  }

  const configPath = stringFlag(parsed, "config", "dev-infra.config.json");
  const config = await loadConfig(configPath);

  if (command === "config" && subcommand === "validate") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          configPath,
          stateRoot: config.stateRoot,
          jobMountRoot: config.jobMountRoot,
          resourceProfiles: Object.keys(config.resourceProfiles),
          managedGitHostKind: config.managedGitHost.kind,
          managedGitHostProtectedRefs: config.managedGitHost.protectedRefs,
          agentImage: config.agent.image,
          secretRuntimeRepo: config.secretRuntime.repo,
          secretRuntimeApprovedRef: config.secretRuntime.approvedRef
        },
        null,
        2
      )
    );
    return;
  }

  if (command === "job" && subcommand === "prepare") {
    const jobId = requiredFlag(parsed, "job-id");
    const profile = stringFlag(parsed, "profile", "default");
    const dryRun = booleanFlag(parsed, "dry-run", false);
    const metadata = await prepareJob(config, runner, jobId, profile, dryRun);
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }

  if (command === "job" && subcommand === "cleanup") {
    const jobId = requiredFlag(parsed, "job-id");
    const dryRun = booleanFlag(parsed, "dry-run", false);
    const removeDisk = !booleanFlag(parsed, "keep-disk", false);
    await cleanupJob(config, runner, jobId, dryRun, removeDisk);
    return;
  }

  if (command === "job" && subcommand === "run") {
    const jobId = requiredFlag(parsed, "job-id");
    const profileName = stringFlag(parsed, "profile", "default");
    const commandArgs = parsed.command.slice(2);
    const exitCode = await runAgentJob(config, runner, {
      jobId,
      profileName,
      command: commandArgs,
      sudo: booleanFlag(parsed, "sudo", true),
      keepDisk: booleanFlag(parsed, "keep-disk", false)
    });
    process.exitCode = exitCode;
    return;
  }

  if (command === "git-host" && subcommand === "init") {
    await initGitHost(config);
    console.log(`Initialized managed Git host state under ${config.stateRoot}`);
    return;
  }

  if (command === "git-host" && subcommand === "create-repo") {
    const repo = requiredFlag(parsed, "repo");
    console.log(await createRepo(config, runner, repo));
    return;
  }

  if (command === "git-host" && subcommand === "install-hooks") {
    const repo = requiredFlag(parsed, "repo");
    console.log(await installRepoHooks(config, repo));
    return;
  }

  if (command === "pr" && subcommand === "create") {
    const record = await createPullRequest(config, runner, {
      repo: requiredFlag(parsed, "repo"),
      sourceRef: requiredFlag(parsed, "source"),
      targetRef: stringFlag(parsed, "target", "refs/heads/main"),
      title: requiredFlag(parsed, "title"),
      body: stringFlag(parsed, "body", "")
    });
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (command === "pr" && subcommand === "list") {
    console.log(JSON.stringify(await listPullRequests(config, requiredFlag(parsed, "repo")), null, 2));
    return;
  }

  if (command === "pr" && subcommand === "show") {
    console.log(JSON.stringify(await readPullRequest(config, requiredFlag(parsed, "repo"), numericFlag(parsed, "id")), null, 2));
    return;
  }

  if (command === "pr" && subcommand === "approve") {
    console.log(JSON.stringify(await approvePullRequest(config, requiredFlag(parsed, "repo"), numericFlag(parsed, "id"), requiredFlag(parsed, "reviewer")), null, 2));
    return;
  }

  if (command === "pr" && subcommand === "merge") {
    console.log(JSON.stringify(await mergePullRequest(config, runner, requiredFlag(parsed, "repo"), numericFlag(parsed, "id")), null, 2));
    return;
  }

  if (command === "secret" && subcommand === "deploy") {
    await deploySecretRuntime(config, runner, booleanFlag(parsed, "dry-run", false));
    return;
  }

  if (command === "controller" && subcommand === "run") {
    await runController(config, runner, {
      once: booleanFlag(parsed, "once", false),
      intervalSeconds: numericFlagWithDefault(parsed, "interval-seconds", 30),
      dryRun: booleanFlag(parsed, "dry-run", false)
    });
    return;
  }

  if (command === "agent" && subcommand === "run-command") {
    const jobId = requiredFlag(parsed, "job-id");
    const metadata = await readJobMetadata(config, jobId);
    const commandArgs = parsed.command.slice(2);
    console.log(buildAgentTimeoutCommand(config, metadata, { name: `dim-${jobId}`, command: commandArgs }));
    return;
  }

  if (command === "agent" && subcommand === "run") {
    const jobId = requiredFlag(parsed, "job-id");
    const metadata = await readJobMetadata(config, jobId);
    const commandArgs = parsed.command.slice(2);
    const timeoutArgs = buildAgentTimeoutArgs(config, metadata, { name: `dim-${jobId}`, command: commandArgs });
    const exitCode = await runner.runStreaming("timeout", timeoutArgs, { sudo: booleanFlag(parsed, "sudo", true) });
    process.exitCode = exitCode;
    return;
  }

  throw new UserError(`Unknown command: ${parsed.command.join(" ")}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      if (command.length > 0) {
        command.push(...argv.slice(index + 1));
        break;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const [key, inlineValue] = withoutPrefix.split("=", 2);
      if (!key) {
        throw new UserError(`Invalid flag: ${arg}`);
      }
      if (inlineValue !== undefined) {
        flags.set(key, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      flags.set(arg.slice(1), true);
      continue;
    }
    command.push(arg);
  }

  return { command, flags };
}

function stringFlag(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags.get(name);
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new UserError(`--${name} requires a value`);
  }
  return value;
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new UserError(`--${name} is required`);
  }
  return value;
}

function booleanFlag(args: ParsedArgs, name: string, fallback: boolean): boolean {
  const value = args.flags.get(name);
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return value === "true" || value === "1" || value === "yes";
}

function numericFlag(args: ParsedArgs, name: string): number {
  const value = requiredFlag(args, name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UserError(`--${name} must be a positive integer`);
  }
  return parsed;
}

function numericFlagWithDefault(args: ParsedArgs, name: string, fallback: number): number {
  if (!args.flags.has(name)) {
    return fallback;
  }
  return numericFlag(args, name);
}

function printHelp(): void {
  console.log(`dev-infra-manager

Usage:
  dim init-config [--output dev-infra.config.json]
  dim doctor
  dim config validate [--config dev-infra.config.json]
  dim job prepare --job-id ID [--profile default] [--config dev-infra.config.json] [--dry-run]
  dim job cleanup --job-id ID [--config dev-infra.config.json] [--dry-run] [--keep-disk]
  dim job run --job-id ID [--profile default] [--config dev-infra.config.json] [--sudo=false] [--keep-disk] [-- COMMAND...]
  dim agent run-command --job-id ID [--config dev-infra.config.json] [COMMAND...]
  dim agent run --job-id ID [--config dev-infra.config.json] [--sudo=false] [-- COMMAND...]
  dim git-host init [--config dev-infra.config.json]
  dim git-host create-repo --repo NAME [--config dev-infra.config.json]
  dim git-host install-hooks --repo NAME [--config dev-infra.config.json]
  dim pr create --repo NAME --source REF --target REF --title TITLE [--body BODY] [--config dev-infra.config.json]
  dim pr list --repo NAME [--config dev-infra.config.json]
  dim pr show --repo NAME --id ID [--config dev-infra.config.json]
  dim pr approve --repo NAME --id ID --reviewer USER [--config dev-infra.config.json]
  dim pr merge --repo NAME --id ID [--config dev-infra.config.json]
  dim secret deploy [--config dev-infra.config.json] [--dry-run]
  dim controller run [--config dev-infra.config.json] [--once] [--interval-seconds 30] [--dry-run]
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UserError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
