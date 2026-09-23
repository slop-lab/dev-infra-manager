import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawn } from "node:child_process";

const temporary = await mkdtemp(path.join(tmpdir(), "dim-cli-local-"));
const tsxImport = import.meta.resolve("tsx");
after(async () => rm(temporary, { recursive: true, force: true }));

test("Given the local CLI When help is requested Then only local authority commands are exposed", async () => {
  const result = await cli(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /approve/);
  assert.match(result.stdout, /run-remote/);
  assert.doesNotMatch(result.stdout, /gitea|ci runner|host-admin/i);
});

test("Given the source CLI When version is requested Then package metadata is reported", async () => {
  const result = await cli(["--version"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "0.9.0");
});

test("Given obsolete local config When a command reads it Then it fails closed with export guidance", async () => {
  const config = path.join(temporary, "obsolete.json");
  const approval = path.join(temporary, "approval.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 0 }));
  await writeFile(approval, "{}");

  const result = await cli(["approve", "--config", config, approval]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /export needed data/);
});

async function cli(args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const entry = path.resolve(import.meta.dirname, "../../../../core/packages/cli/src/cli.ts");
  const child = spawn(process.execPath, ["--import", tsxImport, entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  };
}
