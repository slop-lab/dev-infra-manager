import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "./errors.js";
import type { CommandRunner, DevInfraConfig } from "./types.js";

export type PullRequestStatus = "open" | "merged" | "closed";

export interface PullRequestRecord {
  id: number;
  repo: string;
  title: string;
  body: string;
  sourceRef: string;
  targetRef: string;
  sourceSha: string;
  targetSha: string;
  status: PullRequestStatus;
  approvals: string[];
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergedSha?: string;
}

export function validateRepoName(repo: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(repo) || repo.includes("..")) {
    throw new UserError("repo name must be 1-128 chars of letters, numbers, dot, dash, or underscore");
  }
  return repo;
}

export function gitHostRoot(config: DevInfraConfig): string {
  return join(config.stateRoot, "git-host");
}

export function repoPath(config: DevInfraConfig, repo: string): string {
  return join(gitHostRoot(config), "repos", `${validateRepoName(repo)}.git`);
}

export async function initGitHost(config: DevInfraConfig): Promise<void> {
  await mkdir(join(gitHostRoot(config), "repos"), { recursive: true });
  await mkdir(join(gitHostRoot(config), "prs"), { recursive: true });
}

export async function createRepo(config: DevInfraConfig, runner: CommandRunner, repo: string): Promise<string> {
  const path = repoPath(config, repo);
  await mkdir(dirname(path), { recursive: true });
  const result = await runner.run("git", ["init", "--bare", path]);
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to create bare repo: ${result.stderr}`);
  }
  await mkdir(prDir(config, repo), { recursive: true });
  return path;
}

export async function createPullRequest(
  config: DevInfraConfig,
  runner: CommandRunner,
  input: {
    repo: string;
    sourceRef: string;
    targetRef: string;
    title: string;
    body: string;
  }
): Promise<PullRequestRecord> {
  const repo = validateRepoName(input.repo);
  const sourceSha = await revParse(config, runner, repo, input.sourceRef);
  const targetSha = await revParse(config, runner, repo, input.targetRef);
  const id = await nextPrId(config, repo);
  const now = new Date().toISOString();
  const record: PullRequestRecord = {
    id,
    repo,
    title: input.title,
    body: input.body,
    sourceRef: input.sourceRef,
    targetRef: input.targetRef,
    sourceSha,
    targetSha,
    status: "open",
    approvals: [],
    createdAt: now,
    updatedAt: now
  };
  await writePullRequest(config, record);
  return record;
}

export async function listPullRequests(config: DevInfraConfig, repo: string): Promise<PullRequestRecord[]> {
  const dir = prDir(config, repo);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => JSON.parse(await readFile(join(dir, entry), "utf8")) as PullRequestRecord)
  );
  return records.sort((a, b) => a.id - b.id);
}

export async function readPullRequest(config: DevInfraConfig, repo: string, id: number): Promise<PullRequestRecord> {
  try {
    return JSON.parse(await readFile(prPath(config, repo, id), "utf8")) as PullRequestRecord;
  } catch (error) {
    throw new UserError(`Pull request not found: ${repo}#${id}: ${(error as Error).message}`);
  }
}

export async function approvePullRequest(config: DevInfraConfig, repo: string, id: number, reviewer: string): Promise<PullRequestRecord> {
  const record = await readPullRequest(config, repo, id);
  if (record.status !== "open") {
    throw new UserError(`Pull request ${repo}#${id} is not open`);
  }
  if (!record.approvals.includes(reviewer)) {
    record.approvals.push(reviewer);
  }
  record.updatedAt = new Date().toISOString();
  await writePullRequest(config, record);
  return record;
}

export async function mergePullRequest(config: DevInfraConfig, runner: CommandRunner, repo: string, id: number): Promise<PullRequestRecord> {
  const record = await readPullRequest(config, repo, id);
  if (record.status !== "open") {
    throw new UserError(`Pull request ${repo}#${id} is not open`);
  }
  if (record.approvals.length === 0) {
    throw new UserError(`Pull request ${repo}#${id} has no approvals`);
  }

  const currentSourceSha = await revParse(config, runner, repo, record.sourceRef);
  const currentTargetSha = await revParse(config, runner, repo, record.targetRef);
  if (currentSourceSha !== record.sourceSha) {
    throw new UserError(`Pull request ${repo}#${id} source ref changed after creation`);
  }
  if (currentTargetSha !== record.targetSha) {
    throw new UserError(`Pull request ${repo}#${id} target ref changed after creation`);
  }

  const ancestor = await runner.run("git", ["--git-dir", repoPath(config, repo), "merge-base", "--is-ancestor", record.targetSha, record.sourceSha]);
  if (ancestor.exitCode !== 0) {
    throw new UserError(`Pull request ${repo}#${id} is not a fast-forward merge`);
  }

  const update = await runner.run("git", ["--git-dir", repoPath(config, repo), "update-ref", record.targetRef, record.sourceSha, record.targetSha]);
  if (update.exitCode !== 0) {
    throw new UserError(`Failed to update target ref: ${update.stderr}`);
  }

  const now = new Date().toISOString();
  record.status = "merged";
  record.updatedAt = now;
  record.mergedAt = now;
  record.mergedSha = record.sourceSha;
  await writePullRequest(config, record);
  return record;
}

function prDir(config: DevInfraConfig, repo: string): string {
  return join(gitHostRoot(config), "prs", validateRepoName(repo));
}

function prPath(config: DevInfraConfig, repo: string, id: number): string {
  return join(prDir(config, repo), `${id}.json`);
}

async function nextPrId(config: DevInfraConfig, repo: string): Promise<number> {
  const records = await listPullRequests(config, repo);
  return records.length === 0 ? 1 : Math.max(...records.map((record) => record.id)) + 1;
}

async function writePullRequest(config: DevInfraConfig, record: PullRequestRecord): Promise<void> {
  await mkdir(prDir(config, record.repo), { recursive: true });
  await writeFile(prPath(config, record.repo, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function revParse(config: DevInfraConfig, runner: CommandRunner, repo: string, ref: string): Promise<string> {
  const result = await runner.run("git", ["--git-dir", repoPath(config, repo), "rev-parse", "--verify", ref]);
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to resolve ref ${repo}:${ref}: ${result.stderr}`);
  }
  return result.stdout.trim();
}
