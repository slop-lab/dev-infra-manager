import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../../../../packages/cli", import.meta.url));

export interface PublishedCliFixture { readonly metadataVersion: string; readonly publishedVersion: string; }
export interface PublishedCliResult { readonly status: number | null; readonly stdout: string; readonly stderr: string; }

/** Publish/version checks must never rewrite artifacts used by another CLI test. */
function isolatedPackage(): { root: string; directory: string } {
  const root = mkdtempSync(path.join(tmpdir(), "dim-published-cli-"));
  try {
    const directory = path.join(root, "packages/cli");
    mkdirSync(path.join(directory, "scripts"), { recursive: true });
    mkdirSync(path.join(root, "scripts/packages"), { recursive: true });
    cpSync(path.join(packageDirectory, "dist"), path.join(directory, "dist"), { recursive: true });
    for (const file of ["package.json", "README.md", "scripts/build-publish-package.mjs"]) copyFileSync(path.join(packageDirectory, file), path.join(directory, file));
    copyFileSync(path.resolve(packageDirectory, "../../scripts/publish-package-version.mjs"), path.join(root, "scripts/packages/publish-package-version.mjs"));
    copyFileSync(path.resolve(packageDirectory, "../../LICENSE"), path.join(root, "core/LICENSE"));
    symlinkSync(path.join(packageDirectory, "node_modules"), path.join(directory, "node_modules"), "dir");
    return { root, directory };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export function buildPublishedCli(environment: NodeJS.ProcessEnv): PublishedCliFixture {
  const fixture = isolatedPackage();
  try {
    const packaged = spawnSync(process.execPath, ["scripts/build-publish-package.mjs"], { cwd: fixture.directory, env: environment, encoding: "utf8" });
    assert.equal(packaged.status, 0, packaged.stderr);
    const published = spawnSync(process.execPath, ["dist/cli.js", "--version"], { cwd: fixture.directory, env: environment, encoding: "utf8" });
    assert.equal(published.status, 0, published.stderr);
    return { metadataVersion: JSON.parse(readFileSync(path.join(fixture.directory, "dist/package.json"), "utf8")).version as string,
      publishedVersion: published.stdout.trim() };
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}

export async function runPublishedCli(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<PublishedCliResult> {
  const fixture = isolatedPackage();
  try {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], { cwd: fixture.directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { status, stdout, stderr };
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}
