import { chmod, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./support.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcherSource = join(packageRoot, "src", "dim");

interface Result {
  code: number | null;
  stderr: string;
}

function run(executable: string, args: string[], path: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { PATH: path },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

describe("published dim launcher", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ root: string; bin: string; launcher: string; record: string }> {
    const root = await makeTempDir("dim-launcher-");
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const launcher = join(root, "dim");
    const record = join(root, "args");
    await mkdir(bin);
    await symlink("/usr/bin/dirname", join(bin, "dirname"));
    await symlink("/usr/bin/readlink", join(bin, "readlink"));
    await copyFile(launcherSource, launcher);
    await chmod(launcher, 0o755);
    await writeFile(join(root, "cli.js"), "");
    return { root, bin, launcher, record };
  }

  it("uses an existing supported Node.js directly", async () => {
    const { bin, launcher, record } = await fixture();
    await executable(join(bin, "node"), `#!/bin/sh
if [ "\${1:-}" = -p ]; then echo 24; exit 0; fi
printf '%s\n' "$@" >${JSON.stringify(record)}
`);

    const linkedLauncher = join(bin, "dim");
    await symlink(launcher, linkedLauncher);
    const result = await run(linkedLauncher, ["--help", "value with spaces"], bin);

    expect(result.code).toBe(0);
    expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
      join(dirname(launcher), "cli.js"),
      "--help",
      "value with spaces"
    ]);
  });

  it("uses mise exec node@24 when Node.js is absent from PATH", async () => {
    const { bin, launcher, record } = await fixture();
    await executable(join(bin, "mise"), `#!/bin/sh
printf '%s\n' "\${DIM_INVOKED_VIA_MISE:-}" >${JSON.stringify(`${record}.env`)}
printf '%s\n' "$@" >${JSON.stringify(record)}
`);

    const result = await run(launcher, ["install-cli"], bin);

    expect(result.code).toBe(0);
    expect((await readFile(`${record}.env`, "utf8")).trim()).toBe("1");
    expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
      "exec",
      "node@24",
      "--",
      "node",
      join(dirname(launcher), "cli.js"),
      "install-cli"
    ]);
  });

  it("uses mise exec node@24 when PATH contains an unsupported Node.js", async () => {
    const { bin, launcher, record } = await fixture();
    await executable(join(bin, "node"), `#!/bin/sh
if [ "\${1:-}" = -p ]; then echo 22; exit 0; fi
exit 99
`);
    await executable(join(bin, "mise"), `#!/bin/sh
printf '%s\n' "$@" >${JSON.stringify(record)}
`);

    const result = await run(launcher, ["--version"], bin);

    expect(result.code).toBe(0);
    expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
      "exec",
      "node@24",
      "--",
      "node",
      join(dirname(launcher), "cli.js"),
      "--version"
    ]);
  });

  it("fails actionably when neither a supported Node.js nor mise is available", async () => {
    const { bin, launcher } = await fixture();

    const result = await run(launcher, [], bin);

    expect(result.code).toBe(127);
    expect(result.stderr).toContain("Node.js 24 or 26 is required");
    expect(result.stderr).toContain("install mise");
  });
});
