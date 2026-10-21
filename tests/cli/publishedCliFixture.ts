import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../../packages/cli/core", import.meta.url));

export interface PublishedCliFixture { readonly metadataVersion: string; readonly publishedVersion: string; }
export interface PublishedCliResult { readonly status: number | null; readonly stdout: string; readonly stderr: string; }

/** Publish/version checks must never rewrite artifacts used by another CLI test. */
function isolatedPackage(): { root: string; directory: string } {
  const root = mkdtempSync(path.join(tmpdir(), "dim-published-cli-"));
  try {
    const directory = path.join(root, "packages/cli/core");
    mkdirSync(path.join(directory, "scripts"), { recursive: true });
    mkdirSync(path.join(root, "scripts/packages"), { recursive: true });
    cpSync(path.join(packageDirectory, "dist"), path.join(directory, "dist"), { recursive: true });
    for (const file of ["package.json", "README.md", "scripts/build-publish-package.ts"]) copyFileSync(path.join(packageDirectory, file), path.join(directory, file));
    copyFileSync(path.resolve(packageDirectory, "../../../scripts/packages/publish-package-version.ts"), path.join(root, "scripts/packages/publish-package-version.ts"));
    copyFileSync(path.resolve(packageDirectory, "../../../package.json"), path.join(root, "package.json"));
    copyFileSync(path.resolve(packageDirectory, "../../../LICENSE"), path.join(root, "LICENSE"));
    symlinkSync(path.join(packageDirectory, "node_modules"), path.join(directory, "node_modules"), "dir");
    return { root, directory };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export function buildPublishedCli(environment: NodeJS.ProcessEnv): PublishedCliFixture {
  const fixture = isolatedPackage();
  try {
    const packaged = spawnSync(process.execPath, ["scripts/build-publish-package.ts"], { cwd: fixture.directory, env: environment, encoding: "utf8" });
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
    let invocationEnvironment = environment;
    if (args[0] === "external-url") {
      const home = path.join(fixture.root, "plugins");
      mkdirSync(path.join(home, "node_modules", "@slop-lab"), { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(home, "package.json"), '{"private":true}');
      writeFileSync(path.join(home, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-external-urls"] }));
      symlinkSync(path.resolve(packageDirectory, "../../host/plugins/external-urls"), path.join(home, "node_modules", "@slop-lab", "dim-host-plugin-external-urls"), "dir");
      invocationEnvironment = { ...environment, DIM_PLUGIN_HOME: home };
    }
    const child = spawn(process.execPath, ["dist/cli.js", ...args], { cwd: fixture.directory, env: invocationEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { status, stdout, stderr };
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}
