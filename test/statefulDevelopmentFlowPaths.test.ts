import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verificationRoot = resolve(import.meta.dirname, "..");
const statefulLibrary = resolve(verificationRoot, "scripts/lib/stateful-development-flow.bash");
const statefulSmoke = resolve(verificationRoot, "scripts/stateful-development-flow-smoke.bash");
const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stateful development flow shared-path policy", () => {
  it("wires the smoke entry point to shared-root allocation and explicit controller runtime paths", async () => {
    // Given
    const smoke = await readFile(statefulSmoke, "utf8");

    // When
    const privateTmpAllocation = /mktemp[^\n]*\/tmp/;

    // Then
    expect(smoke).not.toMatch(privateTmpAllocation);
    expect(smoke).toContain('dim_stateful_initialize_work_tree "$repo_root"');
    expect(smoke).toContain("export DIM_AGENT_CONTROLLER_SOCKET");
    expect(smoke).toContain("export XDG_RUNTIME_DIR");
    expect(smoke).toContain("dim_stateful_assert_shared_paths");
  });

  it("exercises failed-first host recovery without losing workspace state", async () => {
    // Given
    const library = await readFile(statefulLibrary, "utf8");
    const smoke = await readFile(statefulSmoke, "utf8");

    // When
    const setupHook = library.slice(
      library.indexOf("install_stateful_setup_hook()"),
      library.indexOf("stop_start_workspace()")
    );
    const markerCheck = setupHook.indexOf("if test -e /tmp/dim-stateful-setup-error; then");
    const markerRemoval = setupHook.indexOf("rm -f /tmp/dim-stateful-setup-error");
    const intentionalExit = setupHook.indexOf("exit 42");
    const standaloneRecovery = library.slice(
      library.indexOf("recover_setup_error()"),
      library.indexOf("stop_controller()")
    );
    const restoredAssertion = library.slice(
      library.indexOf("assert_host_restored()"),
      library.indexOf("recover_setup_error()")
    );
    const maintenanceStart = smoke.indexOf(
      'echo "[full-development-flow] preserve volumes across host shutdown and restore"'
    );
    const laterSetupRecovery = smoke.indexOf('echo "[full-development-flow] recover from setup-error"');
    const maintenanceJourney = smoke.slice(maintenanceStart, laterSetupRecovery);
    const failedStart = maintenanceJourney.indexOf('if dim host start >/dev/null 2>&1; then');
    const secondStart = maintenanceJourney.indexOf("dim host start >/dev/null\n", failedStart + 1);
    const failedRecoveryWindow = maintenanceJourney.slice(failedStart, secondStart);

    // Then
    expect(markerRemoval).toBeGreaterThan(markerCheck);
    expect(markerRemoval).toBeLessThan(intentionalExit);
    expect(maintenanceJourney).toContain(
      'dim workspace exec "$workspace_name" -- touch /tmp/dim-stateful-setup-error'
    );
    expect(maintenanceJourney).toMatch(/touch \/tmp\/dim-stateful-setup-error[\s\S]*dim host shutdown/);
    expect(maintenanceJourney).toContain('if dim host start >/dev/null 2>&1; then');
    expect(maintenanceJourney).toContain('dim host status --json | jq -r .phase)" = error');
    expect(maintenanceJourney).toContain('test -f "$state_root/projects/$project_name.json"');
    expect(maintenanceJourney).toContain('test -f "$state_root/workspaces/$workspace_name.json"');
    expect(maintenanceJourney).toContain(
      'jq -r .phase "$state_root/workspaces/$workspace_name.json")" = setup-error'
    );
    expect(failedRecoveryWindow).toContain(
      'jq -c .resumeWorkspaces "$state_root/host.json")" = "[\\"$workspace_name\\"]"'
    );
    expect(failedRecoveryWindow).toContain(
      'jq -c .restartCiRunners "$state_root/host.json")" = \'[]\''
    );
    expect(failedRecoveryWindow).toContain(
      'jq -c .resumeManagedContainers "$state_root/host.json")" = \'[]\''
    );
    expect(failedRecoveryWindow).not.toMatch(/dim workspace (?:exec|run|setup)\b/);
    expect(maintenanceJourney).toContain('docker volume ls --filter label=dim.managed=true');
    expect(failedRecoveryWindow).toContain('docker exec "$container_name" docker run --rm');
    expect(maintenanceJourney).toContain('--volume "${compose_name}_agent-home:/home:ro"');
    expect(maintenanceJourney).toContain("cat /home/journey-home");
    expect(secondStart).toBeGreaterThan(failedStart);
    expect(maintenanceJourney).toMatch(/cat \/home\/journey-home\)" = persistent-home\ndim host start >\/dev\/null\nassert_host_restored/);
    expect(restoredAssertion).toContain('jq -c .resumeWorkspaces "$state_root/host.json")" = \'[]\'');
    expect(restoredAssertion).toContain('jq -c .restartCiRunners "$state_root/host.json")" = \'[]\'');
    expect(restoredAssertion).toContain('jq -c .resumeManagedContainers "$state_root/host.json")" = \'[]\'');
    expect(maintenanceJourney).toContain("record_ssh_host_key rotated");
    expect(maintenanceJourney).toContain("assert_ssh_session");
    expect(smoke.slice(laterSetupRecovery)).toContain("recover_setup_error");
    expect(standaloneRecovery).not.toContain("rm /tmp/dim-stateful-setup-error");
    expect(standaloneRecovery.match(/dim workspace setup/g)).toHaveLength(2);
  });

  it("defaults isolated runs to a cleanup-owned directory beneath the checkout", async () => {
    // Given
    const checkoutRoot = await temporaryRoot("dim-stateful-checkout-");
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "DIM_EXAMPLE_WORK_ROOT")
    );

    // When
    const result = spawnSync("bash", [
      "-c",
      'set -euo pipefail; source "$1"; dim_stateful_initialize_work_tree "$2"; first="$work_dir"; dim_stateful_initialize_work_tree "$2"; printf "%s\\n%s\\n" "$first" "$work_dir"',
      "bash",
      statefulLibrary,
      checkoutRoot
    ], { encoding: "utf8", env: environment });

    // Then
    expect(result.status, result.stderr).toBe(0);
    const workDirectories = result.stdout.trim().split("\n");
    expect(workDirectories).toHaveLength(2);
    expect(new Set(workDirectories).size).toBe(2);
    for (const path of workDirectories) {
      expect(path.startsWith(`${checkoutRoot}/.local/dim-example-work/`)).toBe(true);
    }
  });

  it("places every sibling-daemon bind source and source fixture beneath the configured shared root", async () => {
    // Given
    const fixtureRoot = await temporaryRoot("dim-stateful-paths-");
    const checkoutRoot = resolve(fixtureRoot, "checkout");
    const sharedRoot = resolve(checkoutRoot, "shared");
    const toolsRoot = resolve(fixtureRoot, "tools");
    const bindLog = resolve(fixtureRoot, "bind-sources.log");
    await mkdir(checkoutRoot);
    await mkdir(toolsRoot);
    const docker = resolve(toolsRoot, "docker");
    await writeFile(docker, `#!/usr/bin/env bash
set -euo pipefail
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --mount ]]; then
    shift
    mount="$1"
    if [[ "$mount" == type=bind,* ]]; then
      source="\${mount#*source=}"
      source="\${source%%,*}"
      case "$source" in
        "$DIM_TEST_SHARED_ROOT"/*) ;;
        *) exit 42 ;;
      esac
      test -e "$source"
      printf '%s\n' "$source" >>"$DIM_TEST_BIND_LOG"
    fi
  fi
  shift
done
`);
    await chmod(docker, 0o700);

    // When
    const result = spawnSync("bash", [
      "-c",
      `set -euo pipefail
source "$1"
dim_stateful_initialize_work_tree "$2"
mkdir -p "$repositories" "$state_root/assets/project-roots/example" "$controller_dir"
dim_stateful_assert_shared_paths
docker_args=(run)
for source in "\${stateful_sibling_bind_sources[@]}"; do
  docker_args+=(--mount "type=bind,source=$source,target=/fixture")
done
docker "\${docker_args[@]}"
printf '%s\n' "$work_dir" "$repositories" "$state_root" "$controller_dir" "$controller_socket" "$agent_controller_socket" "$admin_socket"`,
      "bash",
      statefulLibrary,
      checkoutRoot
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${toolsRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DIM_EXAMPLE_WORK_ROOT: sharedRoot,
        DIM_TEST_BIND_LOG: bindLog,
        DIM_TEST_SHARED_ROOT: sharedRoot
      }
    });

    // Then
    expect(result.status, result.stderr).toBe(0);
    const paths = result.stdout.trim().split("\n");
    expect(paths).toHaveLength(7);
    for (const path of paths) expect(path.startsWith(`${sharedRoot}/`)).toBe(true);
    const bindSources = (await readFile(bindLog, "utf8")).trim().split("\n");
    expect(bindSources).toHaveLength(3);
    for (const source of bindSources) expect(source.startsWith(`${sharedRoot}/`)).toBe(true);
  });

  it("rejects an arbitrary tmp bind source before it reaches the sibling daemon", async () => {
    // Given
    const sharedRoot = await temporaryRoot("dim-stateful-shared-");

    // When
    const result = spawnSync("bash", [
      "-c",
      'set -euo pipefail; source "$1"; stateful_shared_work_root="$2"; repositories="$2/repositories"; state_root="$2/state"; controller_runtime_dir="$2/runtime"; stateful_sibling_bind_sources=("$2/state" /tmp/dim-escaped-controller); dim_stateful_assert_shared_paths',
      "bash",
      statefulLibrary,
      sharedRoot
    ], { encoding: "utf8" });

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bind source escapes shared work root: /tmp/dim-escaped-controller");
  });
});
