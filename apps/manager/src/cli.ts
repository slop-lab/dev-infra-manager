#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
import { lifecycleOptions } from "./lifecycleOptions.js";
import { listRegisteredRepos, registerRepo, showRegisteredRepo } from "./repoRegistry.js";
import {
  createWorkspace,
  discardWorkspace,
  execWorkspace,
  runWorkspace,
  setupWorkspace,
  showWorkspace,
  startWorkspace,
  stopWorkspace,
  updateWorkspace
} from "./workspaceLifecycle.js";
import { ensureGitea } from "./gitea.js";
import { initializeProject } from "./projectScaffold.js";

interface ParsedArgs {
  command: string[];
  flags: Map<string, string | boolean | Array<string | boolean>>;
}

const runner = new ProcessRunner();
const invocationDirectory = resolve(process.env.INIT_CWD ?? process.cwd());
process.chdir(invocationDirectory);

function invocationPath(value: string): string {
  return resolve(invocationDirectory, value);
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const [command, subcommand] = parsed.command;

  if (!command || parsed.flags.has("help") || parsed.flags.has("h")) {
    printHelp();
    return;
  }

  if (command === "init-config") {
    const output = invocationPath(stringFlag(parsed, "output", "dev-infra.config.json"));
    await mkdir(dirname(output), { recursive: true });
    await writeDefaultConfig(output);
    console.log(`Wrote ${output}`);
    return;
  }

  if (command === "doctor") {
    const checks = await runDoctor(runner, parsed.flags.has("config") ? await loadConfig(invocationPath(stringFlag(parsed, "config", "dev-infra.config.json"))) : undefined);
    for (const check of checks) {
      console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
    }
    if (checks.some((check) => !check.ok)) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "repo" && subcommand === "register") {
    const sourcePath = parsed.command[2];
    if (!sourcePath) throw new UserError("repo register requires a bare repository path");
    const record = await registerRepo(runner, lifecycleOptions(), {
      name: requiredFlag(parsed, "name"),
      sourcePath: invocationPath(sourcePath),
      protectedPatterns: commaSeparatedFlag(parsed, "protect", "main")
    });
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (command === "gitea" && subcommand === "ensure") {
    await ensureGitea(runner, lifecycleOptions());
    console.log("Gitea is ready at the configured local endpoint");
    return;
  }

  if (command === "gitea" && subcommand === "credentials") {
    if (!booleanFlag(parsed, "show-secrets", false)) {
      throw new UserError("gitea credentials exposes login secrets; repeat with --show-secrets");
    }
    console.log(JSON.stringify(await ensureGitea(runner, lifecycleOptions()), null, 2));
    return;
  }

  if (command === "repo" && subcommand === "list") {
    console.log(JSON.stringify(await listRegisteredRepos(lifecycleOptions()), null, 2));
    return;
  }

  if (command === "repo" && subcommand === "show") {
    const name = parsed.command[2];
    if (!name) throw new UserError("repo show requires a repository name");
    console.log(JSON.stringify(await showRegisteredRepo(lifecycleOptions(), name), null, 2));
    return;
  }

  if (command === "project" && subcommand === "init") {
    const target = await initializeProject(invocationDirectory, booleanFlag(parsed, "force", false));
    console.log(`Created ${target}`);
    console.log("Next: review .dim/docker-compose.yml, then register this project's bare repository");
    return;
  }

  if (command === "workspace" && subcommand === "create") {
    const project = parsed.command[2];
    const name = parsed.command[3];
    if (!project || !name) throw new UserError("workspace create requires PROJECT and WORKSPACE");
    const gitUserName = optionalStringFlag(parsed, "git-user-name");
    const gitUserEmail = optionalStringFlag(parsed, "git-user-email");
    const record = await createWorkspace(runner, lifecycleOptions(), {
      project,
      name,
      profiles: repeatedStringFlag(parsed, "profile"),
      ...(gitUserName === undefined ? {} : { gitUserName }),
      ...(gitUserEmail === undefined ? {} : { gitUserEmail })
    });
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (command === "workspace" && subcommand === "run") {
    const name = parsed.command[2];
    if (!name || !parsed.command[3]) throw new UserError("workspace run requires WORKSPACE and TASK");
    process.exitCode = await runWorkspace(runner, lifecycleOptions(), {
      name,
      command: parsed.command.slice(3),
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY)
    });
    return;
  }

  if (command === "workspace" && subcommand === "exec") {
    const name = parsed.command[2];
    if (!name || !parsed.command[3]) throw new UserError("workspace exec requires WORKSPACE and COMMAND");
    process.exitCode = await execWorkspace(runner, lifecycleOptions(), {
      name,
      command: parsed.command.slice(3),
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY)
    });
    return;
  }

  if (command === "workspace" && subcommand === "setup") {
    const name = parsed.command[2];
    if (!name) throw new UserError("workspace setup requires a workspace name");
    console.log(JSON.stringify(await setupWorkspace(runner, lifecycleOptions(), name), null, 2));
    return;
  }

  if (command === "workspace" && subcommand === "update") {
    const name = parsed.command[2];
    if (!name) throw new UserError("workspace update requires a workspace name");
    const clearProfiles = booleanFlag(parsed, "clear-profiles", false);
    const profilesProvided = parsed.flags.has("profile");
    if (clearProfiles && profilesProvided) throw new UserError("--clear-profiles cannot be combined with --profile");
    const profiles = clearProfiles ? [] : profilesProvided ? repeatedStringFlag(parsed, "profile") : undefined;
    console.log(JSON.stringify(await updateWorkspace(runner, lifecycleOptions(), name, profiles), null, 2));
    return;
  }

  if (command === "workspace" && subcommand === "start") {
    const name = parsed.command[2];
    if (!name) throw new UserError("workspace start requires a workspace name");
    console.log(JSON.stringify(await startWorkspace(runner, lifecycleOptions(), name), null, 2));
    return;
  }

  if (command === "workspace" && subcommand === "show") {
    const name = parsed.command[2];
    if (!name) throw new UserError("workspace show requires a workspace name");
    console.log(JSON.stringify(await showWorkspace(lifecycleOptions(), name), null, 2));
    return;
  }

  if (command === "workspace" && subcommand === "stop") {
    const name = parsed.command[2];
    if (!name) throw new UserError("workspace stop requires a workspace name");
    await stopWorkspace(runner, lifecycleOptions(), name);
    return;
  }

  if (command === "workspace" && subcommand === "discard") {
    const name = parsed.command[2];
    if (!name) throw new UserError("workspace discard requires a workspace name");
    if (!booleanFlag(parsed, "yes", false)) throw new UserError("workspace discard permanently deletes unpushed changes; repeat with --yes");
    await discardWorkspace(runner, lifecycleOptions(), name);
    return;
  }

  const configPath = invocationPath(stringFlag(parsed, "config", "dev-infra.config.json"));
  const config = await loadConfig(configPath);

  if (command === "config" && subcommand === "validate") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          configPath,
          stateRoot: config.stateRoot,
          jobMountRoot: config.jobMountRoot,
          storageBackend: config.storageBackend.kind,
          resourceProfiles: Object.keys(config.resourceProfiles),
          managedGitHostKind: config.managedGitHost.kind,
          managedGitHostProtectedRefs: config.managedGitHost.protectedRefs,
          agentImage: config.agent.image,
          agentRuntimeBackend: config.agent.runtimeBackend,
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
    const profile = resourceProfileFlag(parsed);
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
    const profileName = resourceProfileFlag(parsed);
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
  const flags = new Map<string, string | boolean | Array<string | boolean>>();

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
        appendFlag(flags, key, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        appendFlag(flags, key, next);
        index += 1;
      } else {
        appendFlag(flags, key, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      appendFlag(flags, arg.slice(1), true);
      continue;
    }
    command.push(arg);
  }

  return { command, flags };
}

function appendFlag(
  flags: ParsedArgs["flags"],
  name: string,
  value: string | boolean
): void {
  const existing = flags.get(name);
  if (existing === undefined) {
    flags.set(name, value);
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    flags.set(name, [existing, value]);
  }
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

function optionalStringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new UserError(`--${name} requires a value`);
  }
  return value;
}

function repeatedStringFlag(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new UserError(`--${name} requires a value`);
  }
  return values as string[];
}

function resourceProfileFlag(args: ParsedArgs): string {
  if (args.flags.has("resource-profile") && args.flags.has("profile")) {
    throw new UserError("--resource-profile cannot be combined with the legacy --profile alias");
  }
  return args.flags.has("resource-profile")
    ? stringFlag(args, "resource-profile", "default")
    : stringFlag(args, "profile", "default");
}

function booleanFlag(args: ParsedArgs, name: string, fallback: boolean): boolean {
  const value = args.flags.get(name);
  if (value === undefined) {
    return fallback;
  }
  if (Array.isArray(value)) throw new UserError(`--${name} may only be specified once`);
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

function commaSeparatedFlag(args: ParsedArgs, name: string, fallback: string): string[] {
  const values = stringFlag(args, name, fallback).split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new UserError(`--${name} must contain at least one value`);
  return values;
}

function printHelp(): void {
  console.log(`dev-infra-manager

Usage:
  dim init-config [--output dev-infra.config.json]
  dim doctor [--config dev-infra.config.json]
  dim config validate [--config dev-infra.config.json]
  dim repo register --name NAME [--protect main,release/*] /path/to/bare/repo.git
  dim repo list
  dim repo show NAME
  dim project init [--force]
  dim gitea ensure
  dim gitea credentials --show-secrets
  dim workspace create PROJECT WORKSPACE [--profile PROFILE ...] [--git-user-name NAME] [--git-user-email EMAIL]
  dim workspace run WORKSPACE TASK [ARGS...]
  dim workspace exec WORKSPACE -- COMMAND [ARGS...]
  dim workspace setup WORKSPACE
  dim workspace update WORKSPACE [--profile PROFILE ... | --clear-profiles]
  dim workspace start WORKSPACE
  dim workspace show WORKSPACE
  dim workspace stop WORKSPACE
  dim workspace discard WORKSPACE --yes
  dim job prepare --job-id ID [--resource-profile default] [--config dev-infra.config.json] [--dry-run]
  dim job cleanup --job-id ID [--config dev-infra.config.json] [--dry-run] [--keep-disk]
  dim job run --job-id ID [--resource-profile default] [--config dev-infra.config.json] [--sudo=false] [--keep-disk] [-- COMMAND...]
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
