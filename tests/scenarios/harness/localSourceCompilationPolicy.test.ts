import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { packageDirectories } from "../../../scripts/pack-local-packages.ts";
import { createCommand } from "../../../scripts/local-uninstall/command.ts";
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
    for (const repository of ["packages/host/plugins/dns-cloudflare", "packages/host/plugins/external-urls", "packages/host/plugins/tailscale", "packages/host/plugins/mirrors"]) {
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

describe.sequential("actual owner publication and matched local dependency graph", () => {
  const repository = resolve(import.meta.dirname, "../../..");
  let graph: { root: string; version: string } | undefined;
  const publishedOwners = new Set<string>();
  const selectedGraph = () => { if (!graph) throw new Error("publication fixture was not prepared"); return graph; };

  beforeAll(async () => {
    const release: unknown = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
    if (typeof release !== "object" || release === null || !("version" in release) || typeof release.version !== "string") throw new Error("root release version is required");
    const root = await mkdtemp(resolve(tmpdir(), "dim-local-publish-graph-"));
    const version = `${release.version}-local-${createHash("sha256").update("production-publish-graph").digest("hex")}`;
    graph = { root, version };
    await mkdir(resolve(root, "scripts/packages"), { recursive: true });
    await copyFile(resolve(repository, "LICENSE"), resolve(root, "LICENSE"));
    await copyFile(resolve(repository, "scripts/packages/publish-package-version.ts"), resolve(root, "scripts/packages/publish-package-version.ts"));
    await copyFile(resolve(repository, "scripts/packages/publish-library.ts"), resolve(root, "scripts/packages/publish-library.ts"));
    await mkdir(resolve(root, "packages/gs"), { recursive: true });
    for (const file of ["build-package.ts", "tsconfig.base.json", "LICENSE"]) {
      await copyFile(resolve(repository, "packages/gs", file), resolve(root, "packages/gs", file));
    }
  });
  afterAll(async () => { if (graph) await rm(graph.root, { recursive: true, force: true }); });

  it.each(packageDirectories)("publishes %s with matched local dependency versions", async (directory) => {
    const { root, version } = selectedGraph();
    const relative = directory.replace(/\/dist$/, "");
    const source = resolve(repository, relative), target = resolve(root, relative);
    await cp(source, target, { recursive: true, filter: (entry) => !entry.split("/").includes("node_modules") });
    await symlink(resolve(source, "node_modules"), resolve(target, "node_modules"));
    const gs = relative.startsWith("packages/gs/");
    const manifest = JSON.parse(await readFile(resolve(target, "package.json"), "utf8")) as { scripts?: { build?: string } };
    if (gs && typeof manifest.scripts?.build !== "string") throw new Error(`${relative} must declare its own builder`);
    const run = createCommand({ ...process.env, GS_BUILD_VERSION: version, DIM_LOCAL_BUILD_VERSION: version },
      { timeoutMilliseconds: 10_000 });
    const publishing = gs
      ? run("/bin/sh", ["-c", 'cd "$1" && exec /bin/sh -c "$2"', "publish-gs", target, manifest.scripts?.build ?? ""])
      : run("/bin/sh", ["-c", 'cd "$1" && exec "$2" "$3"', "publish-dim", target, process.execPath, resolve(target, "scripts/build-publish-package.ts")]);
    const result = await publishing.catch((error: unknown) => { throw new Error(`${relative} publisher could not run`, { cause: error }); });
    expect(result.status, `${relative} publisher: ${result.stderr}`).toBe(0);
    const metadata = JSON.parse(await readFile(resolve(root, directory, "package.json"), "utf8")) as {
      version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
    };
    expect(metadata.version).toBe(version);
    const published = await readFile(resolve(root, directory, "package.json"), "utf8");
    expect(published, `${relative} must expose only built entrypoints`).not.toMatch(/"dim-source"|"\.\/src\//);
    for (const [name, selected] of Object.entries({ ...metadata.dependencies, ...metadata.peerDependencies })) {
      expect(selected, `${relative} must publish registry dependencies`).not.toMatch(/^workspace:/);
      if (name.startsWith("@slop-lab/dim-") || name.startsWith("@slop-lab/gs-")) expect(selected, `${relative} pins ${name}`).toBe(version);
    }
    publishedOwners.add(directory);
  });

  it("packs every published owner and verifies the complete matched dependency graph", async () => {
    const { root, version } = selectedGraph();
    expect([...publishedOwners].sort()).toEqual([...packageDirectories].sort());
    const bundle = resolve(root, "bundle"); await mkdir(bundle);
    // Keep the real all-owner packer, but run it outside this worker so its
    // synchronous pnpm children cannot prevent timeout/cancellation handling.
    const run = createCommand(process.env, { timeoutMilliseconds: 55_000 });
    const result = await run(process.execPath, [resolve(repository, "scripts/pack-local-packages.ts"), root, bundle]);
    expect(result.status, `whole-graph packing: ${result.stderr}`).toBe(0);
    const manifest = JSON.parse(await readFile(resolve(bundle, "packages.json"), "utf8")) as {
      packages: Array<{ name: string; version: string; requires: Record<string, string> }>;
    };
    const packages = manifest.packages;
    expect(packages).toHaveLength(packageDirectories.length);
    expect(new Set(packages.map(({ name }) => name)).size).toBe(packageDirectories.length);
    for (const entry of packages) {
      expect(entry.version).toBe(version);
      for (const [name, required] of Object.entries(entry.requires)) {
        expect(required).toBe(version);
        expect(packages.some((candidate) => candidate.name === name && candidate.version === required)).toBe(true);
      }
    }
  }, 60_000);
});
