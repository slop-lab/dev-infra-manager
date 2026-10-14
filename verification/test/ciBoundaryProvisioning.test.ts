import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CI boundary host-mirror provisioning", () => {
  it("selects the exact packed host-mirror version during shared example installation", async () => {
    // Given: a packed manifest whose aggregate version differs from the source package version.
    const root = await mkdtemp(resolve(tmpdir(), "dim-example-installer-command-"));
    fixtureRoots.push(root);
    const repository = resolve(root, "repository");
    const work = resolve(root, "work");
    const prefix = resolve(root, "prefix");
    const calls = resolve(root, "dim.calls");
    await mkdir(resolve(repository, "verification/scripts"), { recursive: true });
    await mkdir(work);
    await writeFile(resolve(repository, "verification/scripts/pack-local-packages.bash"), `#!/usr/bin/env bash
set -euo pipefail
work="$1"
touch "$work/slop-lab-dim-plugin-host-mirrors-0.9.0-local-fixture.tgz"
printf '%s\n' '{"schemaVersion":1,"packages":[{"name":"@slop-lab/dim-plugin-host-mirrors","version":"0.9.0-local-fixture","file":"slop-lab-dim-plugin-host-mirrors-0.9.0-local-fixture.tgz"}]}' >"$work/packages.json"
`);
    const helper = resolve(workspaceRoot, "verification/scripts/lib/example-dim-install.bash");
    const script = `set -euo pipefail
source "$1"
dim_start_local_npm_registry() { :; }
dim_publish_example_packages() { :; }
npm() { mkdir -p "$4/bin"; printf '#!/usr/bin/env bash\\nprintf "%%s\\n" "$*" >"$DIM_TEST_CALLS"\\nfor socket in "$DIM_CONTROLLER_SOCKET" "$DIM_AGENT_CONTROLLER_SOCKET" "$DIM_ADMIN_CONTROLLER_SOCKET"; do (( \${#socket} <= 107 )) && printf "safe\\n" >>"$DIM_TEST_CALLS"; done\\n' >"$4/bin/dim"; chmod +x "$4/bin/dim"; }
export DIM_STATE_ROOT="$3/state"
dim_install_example_cli "$2" "$3" "$4"
printf '%s\n' "$DIM_EXAMPLE_RUNTIME_DIR"
`;

    // When: the shared helper installs a CLI from that packed bundle.
    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", helper, repository, work, prefix], {
      encoding: "utf8",
      env: { ...process.env, DIM_TEST_CALLS: calls }
    });

    // Then: core installation selects the immutable aggregate version, never a mutable tag.
    expect(result.status, result.stderr).toBe(0);
    fixtureRoots.push(result.stdout.trim());
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "installer install core --no-local-bin --host-mirror-plugin @slop-lab/dim-plugin-host-mirrors@0.9.0-local-fixture",
      "safe",
      "safe",
      "safe"
    ]);
  });

  it("binds compact sockets and stops the owned controller before removing runtime state", async () => {
    // Given: the shared helper, a real Unix-socket fixture, and a CLI stop adapter.
    const root = await mkdtemp(resolve(tmpdir(), "dim-example-controller-lifecycle-"));
    fixtureRoots.push(root);
    const helper = resolve(workspaceRoot, "verification/scripts/lib/example-dim-install.bash");
    const fixture = resolve(root, "controller.mjs");
    const cli = resolve(root, "dim");
    const evidence = resolve(root, "controller.evidence.log");
    await writeFile(fixture, `import fs from "node:fs";
import net from "node:net";
const [pidPath, readyPath, ...sockets] = process.argv.slice(2);
const servers = sockets.map((socket) => net.createServer().listen(socket));
fs.writeFileSync(pidPath, \`\${process.pid}\\n\`, { mode: 0o600 });
Promise.all(servers.map((server) => new Promise((done) => server.once("listening", done))))
  .then(() => fs.writeFileSync(readyPath, "ready\\n"));
process.on("SIGTERM", () => Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  .then(() => process.exit(0)));
`);
    await writeFile(cli, `#!/usr/bin/env bash
set -euo pipefail
test "$1 $2" = "controller stop"
pid="$(cat "$DIM_EXAMPLE_CONTROLLER_PID")"
kill "$pid"
for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.01; done
exit 1
`);
    await chmod(cli, 0o755);
    const script = `set -euo pipefail
source "$1"
export DIM_STATE_ROOT="$2/state"
export DIM_EXAMPLE_DIM_BIN="$3"
dim_prepare_example_controller_runtime
printf '%s\\n' "$DIM_CONTROLLER_SOCKET" "$DIM_AGENT_CONTROLLER_SOCKET" "$DIM_ADMIN_CONTROLLER_SOCKET" |
  awk 'length($0) > 107 { exit 1 }'
mkdir -p "$(dirname "$DIM_EXAMPLE_CONTROLLER_LOG")"
printf 'TOKEN=private-value\\n{"adminPassword":"json-private-value"}\\nstartup failed safely\\n' >"$DIM_EXAMPLE_CONTROLLER_LOG"
node "$4" "$DIM_EXAMPLE_CONTROLLER_PID" "$2/ready" \\
  "$DIM_CONTROLLER_SOCKET" "$DIM_AGENT_CONTROLLER_SOCKET" "$DIM_ADMIN_CONTROLLER_SOCKET" &
fixture_pid=$!
for _ in $(seq 1 100); do test -f "$2/ready" && break; sleep 0.01; done
test -f "$2/ready"
umask 0777
dim_capture_example_controller_failure "$5" "fixture controller"
dim_stop_example_controller
! kill -0 "$fixture_pid" 2>/dev/null
test ! -e "$DIM_EXAMPLE_RUNTIME_DIR"
`;

    // When: the helper owns one complete bind, diagnostic, stop, and removal lifecycle.
    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", helper, root, cli, fixture, evidence], {
      encoding: "utf8",
      env: process.env
    });

    // Then: all sockets bind, secrets are redacted, the PID exits, and evidence remains private.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("startup failed safely");
    expect(result.stderr).toContain("TOKEN=[redacted]");
    expect(result.stderr).not.toContain("private-value");
    expect(result.stderr).not.toContain("json-private-value");
    expect((await stat(evidence)).mode & 0o777).toBe(0o600);
  });

  it("preserves the owned runtime when authenticated controller shutdown is uncertain", async () => {
    // Given: an owned compact runtime and a CLI whose authenticated stop fails.
    const root = await mkdtemp(resolve(tmpdir(), "dim-example-controller-stop-failure-"));
    fixtureRoots.push(root);
    const helper = resolve(workspaceRoot, "verification/scripts/lib/example-dim-install.bash");
    const cli = resolve(root, "dim");
    await writeFile(cli, "#!/usr/bin/env bash\nexit 19\n");
    await chmod(cli, 0o755);
    const script = `set -euo pipefail
source "$1"
export DIM_STATE_ROOT="$2/state"
export DIM_EXAMPLE_DIM_BIN="$3"
dim_prepare_example_controller_runtime
if dim_stop_example_controller; then exit 1; fi
test -d "$DIM_EXAMPLE_RUNTIME_DIR"
printf '%s\\n' "$DIM_EXAMPLE_RUNTIME_DIR"
`;

    // When: cleanup cannot prove that the controller accepted shutdown.
    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", helper, root, cli], {
      encoding: "utf8",
      env: process.env
    });

    // Then: cleanup reports failure and retains the runtime for investigation.
    expect(result.status, result.stderr).toBe(0);
    const runtime = result.stdout.trim();
    fixtureRoots.push(runtime);
    expect(runtime).toMatch(/^\/tmp\/dim-ex-runtime\./);
    expect((await stat(runtime)).isDirectory()).toBe(true);
  });

  it("gives the source CLI boundary owned plugin and controller state with retained failure evidence", async () => {
    // Given: the checked-in KVM source-boundary stage.
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/kvm-guest-verification-smoke.bash"),
      "utf8"
    );

    // When: its source CLI environment and cleanup sequence are inspected.
    const pluginHome = smoke.indexOf('export DIM_PLUGIN_HOME="$state_root/plugins"');
    const reviewedPlugin = smoke.indexOf('"$repo_root/plugin-host-mirrors"');
    const pluginManifest = smoke.indexOf('"@slop-lab/dim-plugin-host-mirrors"');
    const runtimeHome = smoke.indexOf("dim_prepare_example_controller_runtime");
    const pluginBuild = smoke.indexOf("pnpm --filter @slop-lab/dim-plugin-host-mirrors run build");
    const firstSourceCli = smoke.indexOf('source_dim project create "$project"');
    const evidenceCopy = smoke.indexOf('dim_capture_example_controller_failure "$controller_evidence"');
    const safeRemoval = smoke.indexOf("if ((cleanup_status == 0)); then");
    const ownedRemoval = smoke.indexOf('sudo rm -rf "$source_root" "$state_root"');

    // Then: plugin resolution is explicit and diagnostics leave the owned state before deletion.
    expect(pluginHome).toBeGreaterThan(-1);
    expect(reviewedPlugin).toBeGreaterThan(pluginHome);
    expect(pluginManifest).toBeGreaterThan(reviewedPlugin);
    expect(runtimeHome).toBeGreaterThan(-1);
    expect(pluginBuild).toBeGreaterThan(pluginManifest);
    expect(pluginBuild).toBeLessThan(firstSourceCli);
    expect(evidenceCopy).toBeGreaterThan(-1);
    expect(evidenceCopy).toBeLessThan(ownedRemoval);
    expect(safeRemoval).toBeGreaterThan(evidenceCopy);
    expect(safeRemoval).toBeLessThan(ownedRemoval);
    expect(smoke.indexOf("dim_stop_example_controller")).toBeGreaterThan(-1);
    expect(smoke.indexOf("dim_stop_example_controller")).toBeLessThan(ownedRemoval);
  });

  it.each([
    "single-repository-example-smoke.bash",
    "two-repository-example-smoke.bash",
    "multi-repository-example-smoke.bash",
    "ci-runner-example-smoke.bash"
  ])("retains controller evidence and reports uncertain cleanup as 125 in %s", async (script) => {
    // Given: one packed CLI example cleanup boundary.
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts", script),
      "utf8"
    );

    // When: failure evidence and terminal cleanup behavior are inspected.
    const evidenceCopy = smoke.indexOf('dim_capture_example_controller_failure "$controller_evidence"');
    const controllerStop = smoke.indexOf("dim_stop_example_controller");
    const scratchRemoval = smoke.indexOf('rm -rf "$work_dir"');
    const unsafeCleanup = smoke.indexOf("exit 125");
    const safeRemoval = smoke.indexOf("if ((cleanup_status == 0)); then");

    // Then: diagnostics survive scratch deletion and cleanup uncertainty remains distinguishable.
    expect(evidenceCopy).toBeGreaterThan(-1);
    expect(evidenceCopy).toBeLessThan(scratchRemoval);
    expect(controllerStop).toBeGreaterThan(evidenceCopy);
    expect(controllerStop).toBeLessThan(scratchRemoval);
    expect(unsafeCleanup).toBeGreaterThan(-1);
    expect(
      (safeRemoval > controllerStop && safeRemoval < scratchRemoval) || unsafeCleanup < scratchRemoval
    ).toBe(true);
  });
});
