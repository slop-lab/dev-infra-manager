import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlannedCommand } from "./commands.js";
import { repoPath } from "./gitHost.js";
import type { CommandRunner, DevInfraConfig, PlannedCommand } from "./types.js";

export function planSecretDeploy(config: DevInfraConfig, worktree: string): PlannedCommand[] {
  const secret = config.secretRuntime;
  const context = join(worktree, secret.contextPath);
  const dockerfile = join(context, secret.dockerfile);
  const runArgs = [
    "run",
    "--detach",
    "--name",
    secret.containerName,
    "--restart",
    "unless-stopped"
  ];

  for (const publish of secret.publish) {
    runArgs.push("--publish", publish);
  }
  if (secret.envFile) {
    runArgs.push("--env-file", secret.envFile);
  }
  runArgs.push(secret.image);

  return [
    { command: "git", args: ["--git-dir", repoPath(config, secret.repo), "worktree", "add", "--detach", worktree, secret.approvedRef] },
    { command: "docker", args: ["build", "--pull", "--tag", secret.image, "--file", dockerfile, context], sudo: true },
    { command: "docker", args: ["rm", "--force", secret.containerName], sudo: true, allowFailure: true },
    { command: "docker", args: runArgs, sudo: true },
    { command: "git", args: ["--git-dir", repoPath(config, secret.repo), "worktree", "remove", "--force", worktree] }
  ];
}

export async function deploySecretRuntime(config: DevInfraConfig, runner: CommandRunner, dryRun: boolean): Promise<void> {
  const worktree = await mkdtemp(join(tmpdir(), "dim-secret-deploy-"));
  let removeWorktreeWithGit = false;
  try {
    const commands = planSecretDeploy(config, worktree);
    for (const command of commands) {
      await runPlannedCommand(runner, command, dryRun);
      if (command.command === "git" && command.args.includes("worktree") && command.args.includes("add")) {
        removeWorktreeWithGit = !dryRun;
      }
      if (command.command === "git" && command.args.includes("worktree") && command.args.includes("remove")) {
        removeWorktreeWithGit = false;
      }
    }
  } finally {
    if (!dryRun && removeWorktreeWithGit) {
      await runner.run("git", ["--git-dir", repoPath(config, config.secretRuntime.repo), "worktree", "remove", "--force", worktree]);
    }
    await rm(worktree, { recursive: true, force: true });
  }
}
