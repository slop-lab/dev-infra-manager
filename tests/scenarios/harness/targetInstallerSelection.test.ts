import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
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
  // Exercise real package installation and facade selection. Service image
  // preparation and activation have their own disposable integration fixtures.
  await cp(resolve(workspaceRoot, "scripts"), scripts, { recursive: true });
  for (const helper of ["install-local-control-plane", "install-local-web", "install-local-llm-operator", "install-local-llm-gateway", "install-local-shared-ingress", "configure-local-web"]) {
    await writeFile(resolve(scripts, `${helper}.ts`), `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.DIM_INVOCATIONS!, ${JSON.stringify(`service ${helper}\n`)});\n`);
  }
  const sourceInstallation = resolve(scripts, "install-source-build.bash");
  const source = await readFile(sourceInstallation, "utf8");
  const restart = '"${dim_command[@]}" controller restart';
  expect(source).toContain(restart);
  await writeFile(sourceInstallation, source.replace(restart, `printf 'service controller restart\\n' >>"$DIM_INVOCATIONS"`));
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
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    TMPDIR: temporaryRoot,
    HOME: resolve(root, "home"),
    XDG_CONFIG_HOME: resolve(root, "config"),
    DIM_CONFIG_PATH: configPath,
    DIM_DATA_HOME: dataHome,
    DIM_STATE_ROOT: stateRoot,
    DIM_CONTROLLER_SOCKET: resolve(root, "runtime/workspace.sock"),
    DIM_ADMIN_CONTROLLER_SOCKET: resolve(root, "runtime/admin.sock"),
    XDG_RUNTIME_DIR: resolve(root, "runtime"),
    DIM_INVOCATIONS: log,
    DIM_OLD_FACADE_MUTATION: oldFacadeMutation
  };
  const packed = run(process.execPath, [resolve(workspaceRoot, "scripts/pack-local-packages.ts"), workspaceRoot, bundle], environment);
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
    expect(installation.status, installation.stderr).toBe(1);
    expect(installation.stderr).toMatch(
      /workspace state.*work-1\.json.*unsupported workspace state.*export.*currently installed DIM version.*recreat.*no state was changed/is
    );
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

  it("keeps the matching source facade selected by mise after temporary staging is removed", async (context) => {
    const located = spawnSync("which", ["mise"], { encoding: "utf8" });
    if (located.status !== 0) { context.skip(); return; }
    const fixture = await createFixture();
    const tools = resolve(fixture.root, "tools");
    await writeFile(resolve(tools, "mise"), `#!/usr/bin/bash
{ printf 'mise'; printf ' %s' "$@"; printf '\\n'; } >>"$DIM_INVOCATIONS"
exec "$DIM_TEST_REAL_MISE" "$@"
`);
    const miseConfigurationFile = resolve(fixture.root, "mise-config/config.toml");
    const environment: NodeJS.ProcessEnv = { ...fixture.environment,
      PATH: `${dirname(process.execPath)}:${tools}:${process.env.PATH ?? ""}`,
      MISE_DATA_DIR: resolve(fixture.root, "mise-data"),
      MISE_CACHE_DIR: resolve(fixture.root, "mise-cache"),
      MISE_CONFIG_DIR: resolve(fixture.root, "mise-config"),
      MISE_GLOBAL_CONFIG_FILE: miseConfigurationFile,
      MISE_TRUSTED_CONFIG_PATHS: fixture.root,
      DIM_TEST_REAL_MISE: located.stdout.trim()
    };
    const install = () => spawnSync("/usr/bin/bash", [resolve(fixture.root, "scripts/install-source-build.bash")], {
      cwd: fixture.root, env: environment, encoding: "utf8", timeout: 120_000
    });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const installed = install();
      expect(installed.status, installed.stderr).toBe(0);
    }
    const serviceInvocations = await readFile(fixture.log, "utf8");
    expect(serviceInvocations).toContain("service install-local-control-plane\n");
    expect(serviceInvocations).toContain("service controller restart\n");
    expect((await readdir(environment.TMPDIR ?? ""))
      .some((entry) => entry.startsWith("dim-target-installer."))).toBe(false);
    const followup = spawnSync(located.stdout.trim(), ["exec", "--", "dim", "installer", "install", "core",
      "--local-packages", fixture.bundle, "--with-managed", "--no-local-bin"], {
      cwd: fixture.root, env: environment, encoding: "utf8", timeout: 120_000
    });
    expect(followup.status, followup.stderr).toBe(0);
    const version = spawnSync(located.stdout.trim(), ["exec", "--", "dim", "--version"], {
      cwd: fixture.root, env: environment, encoding: "utf8"
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toMatch(/DIM CLI (\S+) \(via DIM installer \1\)/);
    expect(await readFile(miseConfigurationFile, "utf8")).toContain("npm:@slop-lab/dim-installer");
    await expect(readFile(fixture.oldFacadeMutation)).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
