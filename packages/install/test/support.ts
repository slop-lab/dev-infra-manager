import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only helpers for building fake `npm`-shaped commands and fake `dim`
 * standalone executables, so install.ts/cli.ts tests never touch the real
 * npm registry or a real DIM CLI.
 *
 * Everything a fake script needs (paths, expected versions, skip lists) is
 * baked directly into the generated script source at write time rather than
 * passed through environment variables, so tests never have to worry about
 * mutating/restoring shared process.env state.
 */

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeExecutable(target: string, content: string): Promise<void> {
  await writeFile(target, content);
  await chmod(target, 0o755);
}

/**
 * Fake `npm` for `installDimCli`. Records the argv it received (as JSON) to
 * `argsFile`, then - mimicking a real `npm install --prefix <dir> ...` - creates
 * `<dir>/node_modules/.bin/dim` as an executable stub that:
 *   - prints `versionOutput` and exits 0 when invoked with `--version`
 *   - otherwise echoes `dim <args>` to stdout and exits 0
 */
export async function writeFakeCliNpm(
  scriptPath: string,
  options: { argsFile: string; versionOutput: string }
): Promise<void> {
  const content = `#!/usr/bin/env node
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(options.argsFile)}, JSON.stringify(args));

const prefixIndex = args.indexOf("--prefix");
if (prefixIndex === -1) {
  console.error("fake npm: missing --prefix");
  process.exit(1);
}
const versionDirectory = args[prefixIndex + 1];
const binDirectory = path.join(versionDirectory, "node_modules", ".bin");
mkdirSync(binDirectory, { recursive: true });
const stubPath = path.join(binDirectory, "dim");
const stub = ${JSON.stringify(stubDimSource())}.replace("__VERSION__", ${JSON.stringify(options.versionOutput)});
writeFileSync(stubPath, stub);
chmodSync(stubPath, 0o755);
process.exit(0);
`;
  await writeExecutable(scriptPath, content);
}

/**
 * Fake `npm` for `installPlugins`. Records argv to `argsFile`, then merges
 * the requested specifiers into `<cwd>/package.json`'s `dependencies`,
 * mimicking a successful `npm install`. Any package name present in
 * `skipNames` is deliberately NOT added, to simulate npm failing to add a
 * requested package as a direct dependency.
 */
export async function writeFakePluginNpm(
  scriptPath: string,
  options: { argsFile: string; skipNames?: string[] }
): Promise<void> {
  const content = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(options.argsFile)}, JSON.stringify(args));

const skip = new Set(${JSON.stringify(options.skipNames ?? [])});
const specifiers = args.filter((value) => value !== "install" && !value.startsWith("-"));

const pkgPath = path.join(process.cwd(), "package.json");
let pkg = { private: true };
if (existsSync(pkgPath)) {
  pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
}
pkg.dependencies = pkg.dependencies ?? {};
for (const specifier of specifiers) {
  let name;
  let version;
  if (specifier.startsWith("@")) {
    const separator = specifier.indexOf("@", 1);
    name = separator === -1 ? specifier : specifier.slice(0, separator);
    version = separator === -1 ? "0.0.0" : specifier.slice(separator + 1);
  } else {
    const separator = specifier.indexOf("@");
    name = separator === -1 ? specifier : specifier.slice(0, separator);
    version = separator === -1 ? "0.0.0" : specifier.slice(separator + 1);
  }
  if (skip.has(name)) continue;
  pkg.dependencies[name] = version;
}
writeFileSync(pkgPath, \`\${JSON.stringify(pkg, null, 2)}\\n\`);
process.exit(0);
`;
  await writeExecutable(scriptPath, content);
}

function stubDimSource(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("__VERSION__");
  process.exit(0);
}
console.log("dim", args.join(" "));
process.exit(0);
`;
}

/** A standalone fake `dim` executable, independent of any fake npm run. */
export async function writeStubCli(
  scriptPath: string,
  options: { versionOutput: string; echoFile?: string }
): Promise<void> {
  const content = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(${JSON.stringify(options.versionOutput)});
  process.exit(0);
}
${options.echoFile
    ? `writeFileSync(${JSON.stringify(options.echoFile)}, JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  env: {
    DIM_INVOKED_VIA_INSTALLER: process.env.DIM_INVOKED_VIA_INSTALLER ?? null,
    DIM_INSTALLER_VERSION: process.env.DIM_INSTALLER_VERSION ?? null
  }
}));`
    : ""}
console.log("dim", args.join(" "));
process.exit(0);
`;
  await writeExecutable(scriptPath, content);
}

/** A fake executable that always exits with a non-zero status. */
export async function writeFailingStub(scriptPath: string, exitCode = 3): Promise<void> {
  await writeExecutable(scriptPath, `#!/usr/bin/env node\nprocess.exit(${exitCode});\n`);
}
