import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readExampleArtifacts } from "../../../../scripts/examples/bundle.ts";
import { runCommand } from "../../web-lifecycle/process.ts";

export async function fixtureArtifactIdentity(bundle: string, repository: string) {
  const sourceSha = /^root=([a-f0-9]{40})$/m.exec(await readFile(join(bundle, ".dim-source-state"), "utf8"))?.[1];
  if (!sourceSha) throw new Error("fixture artifacts have no exact source identity");
  const sourceTree = (await runCommand("git", ["rev-parse", `${sourceSha}^{tree}`], { cwd: repository })).stdout.trim();
  const artifacts = await readExampleArtifacts(bundle), hash = createHash("sha256"), version = artifacts.find(({ name }) => name === "@slop-lab/dim-cli")?.version;
  if (!version || artifacts.length !== 74) throw new Error("fixture requires the complete matching 74-package bundle");
  for (const artifact of artifacts) {
    const file = join(bundle, artifact.file), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("fixture package artifact is unsafe");
    hash.update(JSON.stringify(artifact)).update(await readFile(file));
  }
  return { sourceSha, sourceTree, version, packageCount: artifacts.length, closureSha256: hash.digest("hex"), manifestSha256: createHash("sha256").update(await readFile(join(bundle, "packages.json"))).digest("hex") };
}
