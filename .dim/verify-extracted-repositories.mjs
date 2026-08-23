import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const temporary = await mkdtemp(path.join(tmpdir(), "dim-repositories-"));
const extracted = path.join(temporary, "repositories");
try {
  execFileSync("node", [path.join(root, ".dim/materialize-repository-boundaries.mjs"), extracted], { cwd: root, stdio: "inherit" });
  const policy = JSON.parse(await readFile(path.join(root, "repository-boundaries.json"), "utf8"));
  const expected = Object.values(policy.owners).filter((rules) => rules.extract !== false).map((rules) => rules.repository).sort();
  const actual = (await readdir(extracted)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`repository set mismatch: expected ${expected.join(", ")}; got ${actual.join(", ")}`);
  const core = path.join(extracted, "core");
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: core, stdio: "inherit" });
  execFileSync("pnpm", ["run", "verify"], { cwd: core, stdio: "inherit" });
  const artifacts = path.join(temporary, "artifacts");
  await mkdir(artifacts);
  for (const packagePath of ["packages/core/dist", "packages/contracts/external-url/dist"]) {
    execFileSync("pnpm", ["pack", "--pack-destination", artifacts], { cwd: path.join(core, packagePath), stdio: "inherit" });
  }
  for (const repository of ["plugin-dns-cloudflare", "plugin-external-urls"]) {
    const plugin = path.join(extracted, repository);
    const manifestPath = path.join(plugin, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies["@slop-lab/dim-contracts-external-url"] = `link:${path.join(core, "packages/contracts/external-url")}`;
    manifest.dependencies["@slop-lab/dim-core"] = `link:${path.join(core, "packages/core")}`;
    delete manifest.peerDependencies["@slop-lab/dim-core"];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(path.join(plugin, "pnpm-lock.yaml"));
    execFileSync("pnpm", ["install", "--no-frozen-lockfile", "--prefer-offline"], { cwd: plugin, stdio: "inherit" });
    for (const script of ["check", "build"]) {
      execFileSync("pnpm", ["run", script], { cwd: plugin, stdio: "inherit" });
    }
  }
  console.log("extracted-repositories-ok");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
