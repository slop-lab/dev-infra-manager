import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { packageDirectories, packLocalPackages } from "../../../scripts/pack-local-packages.ts";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceBuildFixture,
  fixturePackageManifest,
  fixtureRootCommit,
  runSourceBuild,
  type SourceBuildFixture
} from "./localSourceBuildPolicy.fixture.js";

const sourceCommit = { DIM_SOURCE_ROOT_COMMIT: fixtureRootCommit } as const;

const fixtures: SourceBuildFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ root }) => rm(root, { recursive: true, force: true })));
});

describe("exact source plugin compilation", () => {
  it("installs the locked source workspace before recursive compilation and packaging", async () => {
    const fixture = await createSourceBuildFixture();
    fixtures.push(fixture);
    const result = runSourceBuild(fixture, "pack-source-build.bash", sourceCommit);
    const invocations = (await readFile(fixture.log, "utf8")).trim().split("\n");

    expect(result.status).toBe(0);
    const pnpmInvocations = invocations.filter((invocation) => invocation.startsWith("pnpm "));
    expect(pnpmInvocations[0]).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+ install --frozen-lockfile version=/);
    expect(pnpmInvocations).toHaveLength(2);
    expect(pnpmInvocations[1]).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+ --recursive --workspace-concurrency=1 run build version=/);
    expect(invocations.at(-1)).toMatch(/^node .*pack-local-packages\.ts /);
    for (const repository of ["packages/host/plugins/dns-cloudflare", "packages/host/plugins/external-urls", "packages/host/plugins/mirrors"]) {
      expect(await readFile(resolve(fixture.root, `output/${repository}.package.json`), "utf8")).toBe(fixturePackageManifest);
    }
  });

  it("stops before builds and packaging when the workspace install fails", async () => {
    const fixture = await createSourceBuildFixture();
    fixtures.push(fixture);
    const result = runSourceBuild(fixture, "pack-source-build.bash", {
      ...sourceCommit,
      DIM_WORKSPACE_INSTALL_FAILURE: "1"
    });
    const invocations = await readFile(fixture.log, "utf8");

    expect(result.status).toBe(42);
    expect(invocations.match(/^pnpm /gm)).toHaveLength(1);
    expect(invocations).toMatch(/^pnpm --dir \/tmp\/dim-production-source\.[^ ]+ install --frozen-lockfile/m);
    expect(invocations).not.toMatch(/^pnpm .* run build /m);
    expect(invocations).not.toMatch(/^node .*pack-local-packages\.ts /m);
  });
});

it("publishes and packs every actual owner with one matched local dependency graph", async () => {
  const repository = resolve(import.meta.dirname, "../../..");
  const root = await mkdtemp(resolve(tmpdir(), "dim-local-publish-graph-"));
  const release: unknown = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
  if (typeof release !== "object" || release === null || !("version" in release) || typeof release.version !== "string") throw new Error("root release version is required");
  const version = `${release.version}-local-${createHash("sha256").update("production-publish-graph").digest("hex")}`;
  try {
    await mkdir(resolve(root, "scripts/packages"), { recursive: true });
    await copyFile(resolve(repository, "LICENSE"), resolve(root, "LICENSE"));
    await copyFile(resolve(repository, "scripts/packages/publish-package-version.ts"), resolve(root, "scripts/packages/publish-package-version.ts"));
    await copyFile(resolve(repository, "scripts/packages/publish-library.ts"), resolve(root, "scripts/packages/publish-library.ts"));
    for (const directory of packageDirectories) {
      const relative = directory.replace(/\/dist$/, "");
      const source = resolve(repository, relative), target = resolve(root, relative);
      await cp(source, target, { recursive: true, filter: (entry) => !entry.split("/").includes("node_modules") });
      await symlink(resolve(source, "node_modules"), resolve(target, "node_modules"));
      const result = spawnSync(process.execPath, [resolve(target, "scripts/build-publish-package.ts")], {
        cwd: target, encoding: "utf8", env: { ...process.env, DIM_LOCAL_BUILD_VERSION: version }
      });
      expect(result.error, `${relative} publisher could not run`).toBeUndefined();
      expect(result.status, `${relative} publisher: ${result.stderr}`).toBe(0);
      const metadata = JSON.parse(await readFile(resolve(root, directory, "package.json"), "utf8")) as {
        version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
      };
      expect(metadata.version).toBe(version);
      const published = await readFile(resolve(root, directory, "package.json"), "utf8");
      expect(published, `${relative} must expose only built entrypoints`).not.toMatch(/"dim-source"|"\.\/src\//);
      for (const [name, selected] of Object.entries({ ...metadata.dependencies, ...metadata.peerDependencies })) {
        expect(selected, `${relative} must publish registry dependencies`).not.toMatch(/^workspace:/);
        if (name.startsWith("@slop-lab/dim-")) expect(selected, `${relative} pins ${name}`).toBe(version);
      }
    }
    const bundle = resolve(root, "bundle"); await mkdir(bundle);
    const packages = packLocalPackages(root, bundle);
    expect(packages).toHaveLength(packageDirectories.length);
    expect(new Set(packages.map(({ name }) => name)).size).toBe(packageDirectories.length);
    for (const entry of packages) {
      expect(entry.version).toBe(version);
      for (const [name, required] of Object.entries(entry.requires)) {
        expect(required).toBe(version);
        expect(packages.some((candidate) => candidate.name === name && candidate.version === required)).toBe(true);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
