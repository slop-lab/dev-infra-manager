import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const fixtureWorker = fileURLToPath(import.meta.url);
const tsxImport = import.meta.resolve("tsx");
const buildLock = path.join(tmpdir(), "dim-cli-package-version-build.lock");

export interface PublishedCliFixture {
  readonly metadataVersion: string;
  readonly publishedVersion: string;
}

export interface PublishedCliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function buildPublishedCli(environment: NodeJS.ProcessEnv): PublishedCliFixture {
  const result = spawnSync("flock", [
    "--exclusive",
    buildLock,
    process.execPath,
    "--import",
    tsxImport,
    fixtureWorker,
    "--build-fixture"
  ], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: environment
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as PublishedCliFixture;
}

export async function runPublishedCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<PublishedCliResult> {
  const child = spawn("flock", [
    "--exclusive",
    buildLock,
    process.execPath,
    "--import",
    tsxImport,
    fixtureWorker,
    "--run-fixture",
    JSON.stringify(args)
  ], {
    cwd: packageDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

const fixtureMode = process.argv[2];
if (fixtureMode === "--build-fixture" || fixtureMode === "--run-fixture") {
  const build = spawnSync("pnpm", ["run", "build"], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: process.env
  });
  if (build.status !== 0) {
    process.stderr.write(build.stderr);
    process.exit(build.status ?? 1);
  }
  if (fixtureMode === "--run-fixture") {
    const args: unknown = JSON.parse(process.argv[3] ?? "null");
    if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) {
      process.stderr.write("invalid published CLI fixture arguments\n");
      process.exit(1);
    }
    const result = spawnSync(process.execPath, ["dist/cli.js", ...args], {
      cwd: packageDirectory,
      encoding: "utf8",
      env: process.env
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const published = spawnSync(process.execPath, ["dist/cli.js", "--version"], {
    cwd: packageDirectory,
    encoding: "utf8"
  });
  const metadata = spawnSync(process.execPath, ["-p", "require('./dist/package.json').version"], {
    cwd: packageDirectory,
    encoding: "utf8"
  });
  if (published.status !== 0 || metadata.status !== 0) {
    process.stderr.write(published.stderr || metadata.stderr);
    process.exit(published.status ?? metadata.status ?? 1);
  }
  process.stdout.write(JSON.stringify({
    metadataVersion: metadata.stdout.trim(),
    publishedVersion: published.stdout.trim()
  } satisfies PublishedCliFixture));
}
