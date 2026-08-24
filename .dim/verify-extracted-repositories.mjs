import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const temporary = await mkdtemp(path.join(tmpdir(), "dim-repositories-"));
const extracted = path.join(temporary, "repositories");

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

async function linkDependencies(repository, dependencies) {
  const manifestPath = path.join(repository, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.devDependencies ??= {};
  for (const [name, target] of Object.entries(dependencies)) {
    delete manifest.dependencies?.[name];
    delete manifest.peerDependencies?.[name];
    manifest.devDependencies[name] = `link:${target}`;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(path.join(repository, "pnpm-lock.yaml"), { force: true });
}

async function assertProductionSource(repository) {
  const files = execFileSync("find", [".", "-type", "f"], { cwd: repository, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const tests = files.filter((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(file));
  if (tests.length) throw new Error(`${path.basename(repository)} contains development tests: ${tests.join(", ")}`);
  for (const file of files.filter((file) => path.basename(file) === "package.json")) {
    const manifest = JSON.parse(await readFile(path.join(repository, file), "utf8"));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const tool of ["vitest", "tsx"]) {
      if (dependencies[tool]) throw new Error(`${path.basename(repository)}/${file} contains test-only dependency ${tool}`);
    }
  }
}

try {
  run("node", [path.join(root, ".dim/materialize-repository-boundaries.mjs"), extracted], root);
  const policy = JSON.parse(await readFile(path.join(root, "repository-boundaries.json"), "utf8"));
  const expected = Object.values(policy.owners).filter((rules) => rules.extract !== false).map((rules) => rules.repository).sort();
  const actual = (await readdir(extracted)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`repository set mismatch: expected ${expected.join(", ")}; got ${actual.join(", ")}`);
  await access(path.join(extracted, "development", "AGENTS.md"));
  await access(path.join(extracted, "development", ".agents", "skills", "pull-request", "SKILL.md"));

  const core = path.join(extracted, "core");
  await assertProductionSource(core);
  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], core);
  run("pnpm", ["run", "verify"], core);

  const corePackages = {
    "@slop-lab/dim-core": path.join(core, "packages/core"),
    "@slop-lab/dim-contracts-external-url": path.join(core, "packages/contracts/external-url"),
  };
  const coreDevelopment = path.join(extracted, "core-development");
  await linkDependencies(coreDevelopment, corePackages);
  run("pnpm", ["install", "--no-frozen-lockfile", "--prefer-offline"], coreDevelopment);
  run("pnpm", ["run", "check"], coreDevelopment);
  run("pnpm", ["run", "test"], coreDevelopment);

  for (const name of ["plugin-dns-cloudflare", "plugin-external-urls"]) {
    const plugin = path.join(extracted, name);
    await assertProductionSource(plugin);
    await linkDependencies(plugin, corePackages);
    run("pnpm", ["install", "--no-frozen-lockfile", "--prefer-offline"], plugin);
    run("pnpm", ["run", "check"], plugin);
    run("pnpm", ["run", "build"], plugin);

    const development = path.join(extracted, `${name}-development`);
    await linkDependencies(development, corePackages);
    run("pnpm", ["install", "--no-frozen-lockfile", "--prefer-offline"], development);
    run("pnpm", ["run", "check"], development);
    run("pnpm", ["run", "test"], development);
  }
  console.log("extracted-repositories-ok");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
