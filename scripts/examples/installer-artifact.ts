import { execFileSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readExampleArtifacts } from "./bundle.ts";

const input = process.argv[2];
const usage = "usage: node scripts/examples/installer-artifact.ts REVIEWED_BUNDLE";
if (input === "--help" && process.argv.length === 3) { console.log(usage); process.exit(0); }
if (!input || process.argv.length !== 3) throw new Error(usage);
const bundle = resolve(input), artifacts = await readExampleArtifacts(bundle);
for (const artifact of artifacts) {
  const stat = await lstat(join(bundle, artifact.file));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("example artifact must be a regular non-symlink file");
}
const installer = artifacts.find(({ name }) => name === "@slop-lab/dim-installer");
if (!installer) throw new Error("example bundle has no installer");
const file = join(bundle, installer.file);
const archived: unknown = JSON.parse(execFileSync("tar", ["-xOf", file, "package/package.json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 65536 }));
if (!archived || typeof archived !== "object" || !("name" in archived) || archived.name !== installer.name
  || !("version" in archived) || archived.version !== installer.version) throw new Error("installer archive identity differs from the reviewed example manifest");
console.log(file);
