import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const richExamples = ["multi-repository", "full-development-flow"] as const;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rich example runtime regressions", () => {
  it.each(richExamples)("stops and restarts the inner agent while archiving %s", async (example) => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-home-archive-test-"));
    fixtureRoots.push(root);
    const tools = resolve(root, "tools");
    const calls = resolve(root, "docker.calls");
    await mkdir(tools);
    await writeFile(resolve(tools, "docker"), `#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >>"$DIM_TEST_DOCKER_CALLS"
case "$1 $2" in
  'container ls') printf 'outer-agent-dind\n' ;;
  'volume ls') printf 'agent-home-volume\n' ;;
  'inspect --format') printf 'agent-dind-image\n' ;;
  'exec outer-agent-dind')
    if [ "$3 $4 \${5:-}" = 'docker inspect --format' ]; then printf 'true\n'; fi
    ;;
  'run --rm') printf 'archive-bytes' ;;
esac
`);
    await chmod(resolve(tools, "docker"), 0o755);

    const result = spawnSync(
      "/usr/bin/sh",
      [resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim/home-archive.sh"), "backup"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: "dim-project",
          DIM_TEST_DOCKER_CALLS: calls,
          PATH: `${tools}:/usr/bin:/bin`
        }
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("archive-bytes");
    const invocations = await readFile(calls, "utf8");
    expect(invocations).toContain("exec outer-agent-dind dim-agent-dind stop");
    expect(invocations).toContain("exec outer-agent-dind dim-agent-dind start");
    expect(invocations).not.toContain("stop outer-agent-dind");
    expect(invocations).toMatch(
      /run --rm --network none --read-only --mount type=volume,src=agent-home-volume,dst=\/home,readonly --entrypoint tar ubuntu@sha256:[0-9a-f]{64}/
    );
    expect(invocations).not.toContain("agent-dind-image");
  });

  it.each(richExamples)("preserves archive failure while restarting the inner agent for %s", async (example) => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-home-archive-error-test-"));
    fixtureRoots.push(root);
    const tools = resolve(root, "tools");
    const calls = resolve(root, "docker.calls");
    await mkdir(tools);
    await writeFile(resolve(tools, "docker"), `#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >>"$DIM_TEST_DOCKER_CALLS"
case "$1 $2" in
  'container ls') printf 'outer-agent-dind\n' ;;
  'volume ls') printf 'agent-home-volume\n' ;;
  'exec outer-agent-dind')
    if [ "$3 $4 \${5:-}" = 'docker inspect --format' ]; then printf 'true\n'; fi
    ;;
  'run --rm') exit 37 ;;
esac
`);
    await chmod(resolve(tools, "docker"), 0o755);

    const result = spawnSync(
      "/usr/bin/sh",
      [resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim/home-archive.sh"), "backup"],
      { env: { ...process.env, COMPOSE_PROJECT_NAME: "dim-project", DIM_TEST_DOCKER_CALLS: calls, PATH: `${tools}:/usr/bin:/bin` } }
    );

    expect(result.status).toBe(37);
    expect(await readFile(calls, "utf8")).toContain("exec outer-agent-dind dim-agent-dind start");
  });

  it("publishes the complete local package closure in dependency order", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-package-closure-test-"));
    fixtureRoots.push(root);
    const packageNames = [
      "dim-contracts-external-url",
      "dim-controller-proxy",
      "dim-core",
      "plugin-dns-cloudflare",
      "plugin-external-urls",
      "dim-cli",
      "dim-installer"
    ];
    await Promise.all(packageNames.map((name) => writeFile(resolve(root, `${name}-0.9.0-local-test.tgz`), "")));
    const helper = resolve(workspaceRoot, "verification/scripts/lib/example-dim-install.bash");
    const script = `set -euo pipefail
source "$1"
dim_publish_to_local_registry() { printf '%s\n' "$@"; }
dim_publish_example_packages "$2"
`;

    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", helper, root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").map((file) => file.slice(file.lastIndexOf("/") + 1))).toEqual(
      packageNames.map((name) => `${name}-0.9.0-local-test.tgz`)
    );
  });

  it("purges DIM-owned snapshots before removing multi-repository smoke scratch state", async () => {
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/multi-repository-example-smoke.bash"),
      "utf8"
    );

    const purge = smoke.indexOf('dim project purge "$project_name" --yes');
    const scratchRemoval = smoke.indexOf('rm -rf "$work_dir"');
    expect(purge).toBeGreaterThan(-1);
    expect(scratchRemoval).toBeGreaterThan(purge);
  });

  it.each([
    "multi-repository-example-smoke.bash",
    "stateful-development-flow-smoke.bash"
  ])("routes private daemon assertions through the workspace Docker daemon in %s", async (script) => {
    const smoke = await readFile(resolve(workspaceRoot, "verification/scripts", script), "utf8");
    const routedAssertions = smoke.match(
      /docker\(\) \{ dim workspace exec "\$workspace_name" -- docker "\$@"; \}\n\s+dim_assert_private_dind_unix_only/g
    );

    expect(routedAssertions).toHaveLength(2);
  });

  it("configures the external URL example with host approval required", async () => {
    // Given: a recording DIM executable used by the checked-in host configuration script.
    const root = await mkdtemp(resolve(tmpdir(), "dim-external-url-config-test-"));
    fixtureRoots.push(root);
    const dim = resolve(root, "dim");
    const calls = resolve(root, "dim.calls");
    await writeFile(dim, "#!/usr/bin/env sh\nprintf '%s\\n' \"$*\" >>\"$DIM_TEST_CALLS\"\n");
    await chmod(dim, 0o755);

    // When: the example configures its default ingress.
    const result = spawnSync(
      "/usr/bin/bash",
      [resolve(workspaceRoot, "examples/features/external-urls/configure-ingress.bash")],
      { encoding: "utf8", env: { ...process.env, DIM_BIN: dim, DIM_TEST_CALLS: calls } }
    );

    // Then: host approval is an explicit part of the ingress contract.
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(calls, "utf8")).toContain("--require-approval");
  });

  it("requests the example routes through the workspace development helper", async () => {
    // Given: a recording DIM executable standing in for the pinned host CLI.
    const root = await mkdtemp(resolve(tmpdir(), "dim-external-url-request-test-"));
    fixtureRoots.push(root);
    const dim = resolve(root, "dim");
    const calls = resolve(root, "dim.calls");
    await writeFile(dim, "#!/usr/bin/env sh\nprintf '%s\\n' \"$*\" >>\"$DIM_TEST_CALLS\"\n");
    await chmod(dim, 0o755);

    // When: the checked-in host script dispatches URL requests into one workspace.
    const result = spawnSync(
      "/usr/bin/bash",
      [resolve(workspaceRoot, "examples/features/external-urls/request-urls.bash"), "external-dev"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DIM_BIN: dim,
          DIM_TEST_CALLS: calls,
        }
      }
    );

    // Then: both nested targets use the workspace helper without a foreign workspace selector.
    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "workspace exec external-dev -- dim-development-service request-url --ingress local-http --container dev --port 8080",
      "workspace exec external-dev -- dim-development-service request-url --ingress local-http --container dev --container deep --port 5678"
    ]);
  });

  it("installs the external URL smoke runtime package closure", async () => {
    // Given: the executable external URL smoke fixture.
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/external-url-example-smoke.bash"),
      "utf8"
    );

    // When: its exact-local package references are inspected.
    const controllerProxyArchives = smoke.match(/package_archive @slop-lab\/dim-controller-proxy/g);
    const hostMirrorArchives = smoke.match(/package_archive @slop-lab\/dim-plugin-host-mirrors/g);
    const hostMirrorPluginEntries = smoke.match(/"@slop-lab\/dim-plugin-host-mirrors"/g);

    // Then: both package roots receive controller-proxy and the controller loads its host-mirror provider.
    expect(controllerProxyArchives).toHaveLength(2);
    expect(hostMirrorArchives).toHaveLength(1);
    expect(hostMirrorPluginEntries).toHaveLength(1);
  });

  it("runs the container integration preflight before the external URL smoke", async () => {
    // Given: the executable external URL smoke fixture.
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/external-url-example-smoke.bash"),
      "utf8"
    );

    // When: the first verification phase is located.
    const preflight = smoke.indexOf('bash "$script_dir/container-integration-preflight.bash"');
    const packageBuild = smoke.indexOf('echo "[external-url-example] build local packages and workspace image"');

    // Then: unsupported nested-container hosts fail explicitly before expensive setup.
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(packageBuild);
  });

  it("mounts the external URL workspace from its canonical protected root", async () => {
    // Given: the executable external URL smoke fixture.
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/external-url-example-smoke.bash"),
      "utf8"
    );

    // When: its protected-root fixture and mount proof are inspected.
    const canonicalRoot = 'protected_root="$state_root/assets/project-roots/$project_id/$root_commit"';
    const immutableMount = '--mount "type=bind,src=$protected_root,dst=/run/dim/project-root,readonly"';
    const inspectedMount = '= "$protected_root|false"';

    // Then: lifecycle ownership sees the same canonical read-only source recorded by the workspace.
    expect(smoke).toContain(canonicalRoot);
    expect(smoke).toContain(immutableMount);
    expect(smoke).toContain(inspectedMount);
    expect(smoke).not.toContain("host_project_root");
  });
});
