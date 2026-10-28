import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { percentileSummary } from "./native-history-metrics.js";

const retainedDiagnosticBytes = 2_048;
const processOutputBytes = 8_192;
const processDeadlineMilliseconds = 60_000;

type GitReadSample = {
  readonly startedAt: string;
  readonly milliseconds: number;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly spawnCode: string | null;
  readonly signal: string | null;
  readonly classification: "success" | "git-exit-128" | "process-failure" | "output-bound" | "deadline" | "invalid-head-output";
  readonly stderr: string;
  readonly stderrCapturedBytes: number;
  readonly stderrTruncated: boolean;
};

export function sanitizeGitReadDiagnostic(input: string): string {
  const safe = input
    .replace(/^.*(?:proxy-authorization|authorization)\s*[:=].*$/gim, "[authorization redacted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[authorization redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, "[URL redacted]")
    .replace(/\b(?:access[_-]?token|token|password|secret|api[_-]?key|credential)\s*[:=]\s*[^\r\n]+/gi, "[secret redacted]")
    .replace(/^\s*remote:.*$/gim, "[remote response omitted]")
    .replace(/(^|[\s"'=])\/(?:home|root|run|var\/run|mnt|workspace)\/[^\s"'<>]*/g, "$1[private path]");
  const prefixBudget = retainedDiagnosticBytes - Buffer.byteLength("\uFFFD");
  return Buffer.from(safe, "utf8").subarray(0, prefixBudget).toString("utf8");
}

export function sampleGitHead(workingTree: string): Promise<GitReadSample> {
  const startedAt = new Date().toISOString(), started = performance.now();
  return new Promise((complete) => {
    execFile("git", ["-c", "protocol.version=0", "ls-remote", "origin", "HEAD"], {
      cwd: workingTree, encoding: "utf8", maxBuffer: processOutputBytes,
      timeout: processDeadlineMilliseconds, killSignal: "SIGTERM",
      env: { ...process.env, GIT_MASTER: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
    }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      const spawnCode = typeof error?.code === "string" ? error.code : null;
      const validHead = /^(?:[0-9a-f]{40}|[0-9a-f]{64})\tHEAD\r?\n?$/.test(stdout);
      const ok = error === null && validHead;
      const classification = ok ? "success" : spawnCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-bound"
        : error?.killed ? "deadline" : exitCode === 128 ? "git-exit-128"
          : error === null ? "invalid-head-output" : "process-failure";
      complete({ startedAt, milliseconds: Math.round((performance.now() - started) * 1_000) / 1_000,
        ok, exitCode, spawnCode, signal: error?.signal ?? null, classification,
        stderr: sanitizeGitReadDiagnostic(stderr), stderrCapturedBytes: Buffer.byteLength(stderr),
        stderrTruncated: Buffer.byteLength(stderr) > retainedDiagnosticBytes || classification === "output-bound" });
    });
  });
}

class GitReadEvidenceError extends Error { readonly name = "GitReadEvidenceError"; }

async function main(): Promise<void> {
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    process.stdout.write("Usage: native-git-read-evidence.ts WORKTREE [SAMPLES=5]\nRead-only own-origin HEAD samples, without retries or response-body retention.\n");
    return;
  }
  const directory = process.argv[2], count = Number(process.argv[3] ?? "5");
  if (directory === undefined || !Number.isInteger(count) || count < 1 || count > 20) {
    throw new GitReadEvidenceError("Expected WORKTREE and an integer sample count from 1 through 20; use --help");
  }
  const workingTree = resolve(directory), samples: GitReadSample[] = [];
  for (let index = 0; index < count; index++) samples.push(await sampleGitHead(workingTree));
  const succeeded = samples.filter(({ ok }) => ok);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, node: process.version, workingTree,
    command: "git -c protocol.version=0 ls-remote origin HEAD", sequential: true,
    retries: 0, deployedByRunner: false, responseBodiesRetained: false,
    controls: { processDeadlineMilliseconds, processOutputBytes, retainedDiagnosticBytes },
    sampleCount: samples.length, failureCount: samples.length - succeeded.length,
    allLatency: percentileSummary(samples.map(({ milliseconds }) => milliseconds)),
    successLatency: succeeded.length === 0 ? null : percentileSummary(succeeded.map(({ milliseconds }) => milliseconds)),
    samples })}\n`);
  if (succeeded.length !== samples.length) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.name : "UnknownError",
      diagnostic: sanitizeGitReadDiagnostic(error instanceof Error ? error.message : String(error)) })}\n`);
    process.exitCode = 1;
  });
}
