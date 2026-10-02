import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

type Fixture = {
  readonly root: string;
  readonly bundle: string;
  readonly readiness: string;
  readonly log: string;
  readonly oldFacadeMutation: string;
  readonly environment: NodeJS.ProcessEnv;
};

function run(command: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(command, arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-target-installer-selection-"));
  roots.push(root);
  const scripts = resolve(root, "scripts");
  const tools = resolve(root, "tools");
  const bundle = resolve(root, ".local/dim-packages");
  const readiness = resolve(root, ".local/prepared-local.state");
  const log = resolve(root, "invocations.log");
  const oldFacadeMutation = resolve(root, "old-facade-mutated");
  const temporaryRoot = resolve(root, "temporary");
  const stateRoot = resolve(root, "state");
  const configPath = resolve(root, "installed/config.json");
  const dataHome = resolve(root, "installed/data");
  await Promise.all([scripts, tools, bundle, temporaryRoot, stateRoot, resolve(configPath, "..")]
    .map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all(["install-source-build.bash", "local-package-version.bash"].map((script) =>
    copyFile(resolve(workspaceRoot, "scripts", script), resolve(scripts, script))
  ));
  await writeFile(resolve(scripts, "local-preparation-state.bash"), `#!/usr/bin/bash
printf 'state\n' >>"$DIM_INVOCATIONS"
printf 'state=fresh\n'
`);
  await writeFile(readiness, "state=fresh\n");
  await writeFile(resolve(tools, "mise"), `#!/usr/bin/bash
{ printf 'mise'; printf ' %s' "$@"; printf '\n'; } >>"$DIM_INVOCATIONS"
[[ "$1" == "exec" && "$2" == "--" ]]
shift 2
if [[ "$1" == "dim" ]]; then
  touch "$DIM_OLD_FACADE_MUTATION"
  exit 88
fi
exec "$@"
`);
  await Promise.all([resolve(scripts, "local-preparation-state.bash"), resolve(tools, "mise")]
    .map((path) => chmod(path, 0o755)));
  const environment = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    TMPDIR: temporaryRoot,
    HOME: resolve(root, "home"),
    DIM_CONFIG_PATH: configPath,
    DIM_DATA_HOME: dataHome,
    DIM_STATE_ROOT: stateRoot,
    DIM_INVOCATIONS: log,
    DIM_OLD_FACADE_MUTATION: oldFacadeMutation
  };
  const packed = run("/usr/bin/bash", [resolve(workspaceRoot, "verification/scripts/pack-local-packages.bash"), bundle], environment);
  expect(packed.status, packed.stderr).toBe(0);
  return { root, bundle, readiness, log, oldFacadeMutation, environment };
}

async function bundleBytes(bundle: string): Promise<readonly Buffer[]> {
  const entries = (await readdir(bundle)).sort();
  return Promise.all(entries.map((entry) => readFile(resolve(bundle, entry))));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("target installer selection", () => {
  it("uses the packed target facade before any installed mutation when old mise facade would mutate", async () => {
    // Given
    const fixture = await createFixture();
    const current = resolve(fixture.root, "installed/data/runtime/current");
    const statePath = resolve(fixture.root, "state/workspaces/work-1.json");
    const imageMarker = resolve(fixture.root, "state/image-marker");
    await Promise.all([current, resolve(statePath, "..")].map((directory) => mkdir(directory, { recursive: true })));
    await writeFile(resolve(current, "runtime-marker"), "old runtime\n");
    await writeFile(resolve(current, "plugins.json"), '{"schemaVersion":1,"plugins":[]}\n');
    await writeFile(resolve(current, "package.json"), '{"dependencies":{}}\n');
    await writeFile(fixture.environment.DIM_CONFIG_PATH ?? "", '{"schemaVersion":1,"preserved":"config"}\n');
    await writeFile(statePath, '{"schemaVersion":5,"name":"work-1","secret":"do-not-print"}\n');
    await writeFile(imageMarker, "prepared image identity\n");
    const protectedPaths = [
      fixture.readiness,
      resolve(current, "runtime-marker"),
      resolve(current, "plugins.json"),
      resolve(current, "package.json"),
      fixture.environment.DIM_CONFIG_PATH ?? "",
      statePath,
      imageMarker
    ] as const;
    const before = await Promise.all(protectedPaths.map((path) => readFile(path)));
    const bundleBefore = await bundleBytes(fixture.bundle);

    // When
    const installation = run("/usr/bin/bash", [resolve(fixture.root, "scripts/install-source-build.bash")], fixture.environment);
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(installation.status).toBe(1);
    expect(installation.stderr).toMatch(/workspace.*schema 5.*pinned DIM version.*export.*recreate/is);
    expect(installation.stderr).not.toContain("do-not-print");
    expect(invocations).toMatch(/^mise exec -- npm install --prefix .*dim-target-installer\./m);
    expect(invocations).toMatch(/^mise exec -- .*dim-target-installer\..*\/dim installer install core /m);
    expect(invocations).not.toContain("mise exec -- dim");
    expect(invocations).not.toContain("npm install --global");
    expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before);
    expect(await bundleBytes(fixture.bundle)).toEqual(bundleBefore);
    await expect(readFile(fixture.oldFacadeMutation)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fixture.environment.TMPDIR ?? ""))
      .some((entry) => entry.startsWith("dim-target-installer."))).toBe(false);
  }, 120_000);

  it("accepts strict host schema 1 through the packed target without installation-time migration", async () => {
    // Given
    const fixture = await createFixture();
    const hostPath = resolve(fixture.root, "state/host.json");
    const hostBytes = `${JSON.stringify({
      schemaVersion: 1,
      phase: "stopped",
      resumeWorkspaces: [],
      resumeCiRunners: [],
      resumeManagedContainers: [],
      updatedAt: "before-install"
    }, null, 2)}\n`;
    await writeFile(hostPath, hostBytes);
    const bundleBefore = await bundleBytes(fixture.bundle);

    // When
    const installation = run("/usr/bin/bash", [resolve(fixture.root, "scripts/install-source-build.bash")], fixture.environment);
    const invocations = await readFile(fixture.log, "utf8");

    // Then
    expect(installation.status, installation.stderr).toBe(0);
    expect(installation.stderr).toContain("will be migrated with a permanent backup at controller startup");
    expect(await readFile(hostPath, "utf8")).toBe(hostBytes);
    expect(await bundleBytes(fixture.bundle)).toEqual(bundleBefore);
    expect(invocations.match(/^state$/gm)).toHaveLength(2);
    expect(invocations).not.toContain("mise exec -- dim");
    expect(invocations).not.toContain("npm install --global");
    await expect(readFile(fixture.oldFacadeMutation)).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
