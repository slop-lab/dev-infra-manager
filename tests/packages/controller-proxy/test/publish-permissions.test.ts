import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const publisher = path.join(repositoryRoot, "core/packages/controller-proxy/scripts/build-publish-package.mjs");
const sourcePackage = path.join(repositoryRoot, "core/packages/controller-proxy/package.json");
const versionHelper = path.join(repositoryRoot, "core/scripts/publish-package-version.mjs");
const minifierPackage = path.dirname(createRequire(sourcePackage).resolve("package.json-minifier"));
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((item) => item())));

describe("controller-proxy public package permissions", () => {
  it("publishes a non-root-readable runtime closure under a restrictive umask", async () => {
    // Given: an isolated mirror of the publisher layout with private input modes.
    const fixture = await createPublisherFixture();

    // When: publication runs under the verification stage's restrictive umask.
    const published = spawnSync("/bin/sh", ["-c", "umask 077; exec node scripts/build-publish-package.mjs"], {
      cwd: fixture.packageRoot,
      encoding: "utf8"
    });

    // Then: public files are readable, package bins executable, and the runtime closure runs unprivileged.
    expect(published).toMatchObject({ status: 0, stderr: "" });
    await expectModes(fixture.packageRoot);
    const currentUid = process.geteuid?.();
    const effectiveUid = currentUid === 0 ? 65_534 : currentUid;
    const helper = spawnSync(process.execPath, [path.join(fixture.packageRoot, "dist/development-service-cli.js")], {
      cwd: fixture.root,
      encoding: "utf8",
      ...(currentUid === 0 ? { uid: 65_534, gid: 65_534 } : {})
    });
    expect(helper.error).toBeUndefined();
    expect(helper).toMatchObject({ status: 0, stderr: "", stdout: `${effectiveUid}:runtime-contract-ok\n` });
  });
});

type PublisherFixture = {
  readonly root: string;
  readonly packageRoot: string;
};

async function createPublisherFixture(): Promise<PublisherFixture> {
  const root = await mkdtemp("/tmp/dim-controller-proxy-publisher-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "core/packages/controller-proxy");
  const externalDist = path.join(root, "core/packages/contracts/external-url/dist");
  await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await mkdir(path.join(packageRoot, "dist/nested"), { recursive: true });
  await mkdir(externalDist, { recursive: true });
  await mkdir(path.join(root, "core/scripts"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await Promise.all([
    copyFile(publisher, path.join(packageRoot, "scripts/build-publish-package.mjs")),
    copyFile(sourcePackage, path.join(packageRoot, "package.json")),
    copyFile(versionHelper, path.join(root, "core/scripts/publish-package-version.mjs")),
    writeFile(path.join(packageRoot, "README.md"), "public package\n"),
    writeFile(path.join(root, "core/LICENSE"), "MIT\n"),
    writeFile(path.join(externalDist, "index.js"), "export const marker = 'runtime-contract-ok';\n"),
    writeFile(path.join(packageRoot, "dist/index.js"), "export {};\n"),
    writeFile(path.join(packageRoot, "dist/nested/index.d.ts"), "export {};\n"),
    ...["cli.js", "workspace-resources-cli.js", "nproc-cli.js"].map((name) =>
      writeFile(path.join(packageRoot, "dist", name), "#!/usr/bin/env node\n")),
    writeFile(path.join(packageRoot, "dist/development-service-cli.js"),
      "#!/usr/bin/env node\nimport { marker } from \"@slop-lab/dim-contracts-external-url\";\nprocess.stdout.write(`${process.geteuid()}:${marker}\\n`);\n")
  ]);
  await symlink(minifierPackage, path.join(root, "node_modules/package.json-minifier"), "dir");
  for (const directory of [root, path.join(root, "core"), path.join(root, "core/packages"), packageRoot]) {
    await chmod(directory, 0o755);
  }
  await chmod(path.join(packageRoot, "dist"), 0o700);
  await chmod(path.join(packageRoot, "dist/nested"), 0o700);
  return { root, packageRoot };
}

async function expectModes(packageRoot: string): Promise<void> {
  const dist = path.join(packageRoot, "dist");
  for (const directory of [dist, path.join(dist, "nested"), path.join(dist, "runtime-dependencies"),
    path.join(dist, "runtime-dependencies/dim-contracts-external-url")]) {
    expect((await stat(directory)).mode & 0o777, directory).toBe(0o755);
  }
  for (const file of ["index.js", "nested/index.d.ts", "package.json", "README.md", "LICENSE",
    "runtime-dependencies/dim-contracts-external-url/index.js"]) {
    expect((await stat(path.join(dist, file))).mode & 0o777, file).toBe(0o644);
  }
  for (const executable of ["cli.js", "development-service-cli.js", "workspace-resources-cli.js", "nproc-cli.js"]) {
    expect((await stat(path.join(dist, executable))).mode & 0o777, executable).toBe(0o755);
  }
}
