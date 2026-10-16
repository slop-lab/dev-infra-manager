import { access, mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredDimAgentController, configuredDimController } from "../../core/packages/core/src/controller.js";
import { ensureAptCache } from "../../core/packages/core/src/aptCache.js";
import { lifecycleOptionsForBackend } from "../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../core/packages/core/src/lifecycleState.js";
import { loadNativeControlPlaneConnection } from "../../core/packages/core/src/nativeControlPlaneConnection.js";
import { createNodeNativeGitRootImporterClient } from "../../core/packages/core/src/nativeGitRootImporterClient.js";
import { NativeProjectPendingStore } from "../../core/packages/core/src/nativeProjectPendingStore.js";
import { registerPlugins } from "../../core/packages/core/src/plugin.js";
import { ensureRegistryCache } from "../../core/packages/core/src/registryCache.js";
import { ProcessRunner } from "../../core/packages/core/src/runner.js";
import { workspaceAgentIdentity } from "../../core/packages/core/src/workspaceAgentRuntime.js";
import { buildWorkspaceImage } from "../../core/packages/core/src/workspaceImage.js";
import {
  createWorkspace,
  discardWorkspace,
  restartWorkspace,
  startWorkspace,
  stopWorkspace,
  updateWorkspace
} from "../../core/packages/core/src/workspaceLifecycle.js";
import {
  cleanupNativeProjectFixtures,
  nativeFixture
} from "../../tests/packages/cli/test/nativeProjectCommandsFixture.js";
import { hostMirrorProvider, plugin as hostMirrorPlugin } from "../../plugin-host-mirrors/src/index.js";
import {
  nativeLifecycleCommandFailure,
  nativeLifecycleFailure
} from "./nativeBasicLifecycleDiagnostics.js";

const runner = new ProcessRunner();

describe("native basic lifecycle live mechanics", () => {
  it("persists a proposal-only checkout through native Sysbox lifecycle transitions", async () => {
    const runtimeInventory = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], {
      signal: AbortSignal.timeout(30_000)
    });
    expect(runtimeInventory.exitCode).toBe(0);
    expect(runtimeInventory.stdout).toContain("sysbox-runc");

    const runId = `${process.pid}-${Date.now()}`;
    const image = `dim-native-basic-lifecycle:${runId}`;
    const fixture = await nativeFixture({ workspaceWriteLeaseClock: Date.now });
    const options = { ...lifecycleOptionsForBackend("sysbox", {
      ...fixture.environment,
      DIM_WORKSPACE_IMAGE: image
    }), hostMirrorProvider };
    const plugins = await registerPlugins([hostMirrorPlugin]);
    const controllers = [
      configuredDimController(options, plugins, runner),
      configuredDimAgentController(options, plugins, runner)
    ];
    const workspaceName = `native-basic-${runId}`;
    let imageBuilt = false;

    let primaryFailure: unknown;
    try {
      await projectControllerScopeHostMirror(fixture.stateRoot);
      await buildWorkspaceImage(runner, { ...fixture.environment, DIM_WORKSPACE_IMAGE: image }, {
        signal: AbortSignal.timeout(300_000)
      });
      imageBuilt = true;
      await Promise.all([
        listen(controllers[0], options.controllerSocketPath),
        listen(controllers[1], options.agentControllerSocketPath)
      ]);

      const projects = new NativeProjectPendingStore(fixture.stateRoot);
      await projects.admit("acme", await createNodeNativeGitRootImporterClient(fixture.importerPath),
        AbortSignal.timeout(10_000));
      await projects.ready("acme", await loadNativeControlPlaneConnection(fixture.controlPath),
        AbortSignal.timeout(10_000));

      const workspace = await createWorkspace(runner, options, {
        project: "acme",
        name: workspaceName,
        profiles: [],
        runtimeBackend: "sysbox",
        kvm: false,
        gitUserName: "DIM native lifecycle",
        gitUserEmail: "native-lifecycle@dim.invalid"
      });
      expect(workspace).toMatchObject({ schemaVersion: 9, phase: "ready", environment: "recommended" });

      const agent = workspaceAgentIdentity(workspace).containerName;
      await assertWorkspaceVerificationCapabilities(agent);
      const proposal = `refs/heads/proposals/${workspace.workspaceId}/native-basic`;
      const pushed = await runner.run("docker", [
        "exec", "--user", "dim", "--workdir", "/workspace", agent,
        "bash", "-lc", candidateScript, "bash", proposal, fixture.commit
      ], { signal: AbortSignal.timeout(30_000) });
      if (pushed.exitCode !== 0) throw nativeLifecycleCommandFailure("candidate proposal push", pushed);
      const candidate = pushed.stdout.trim().split("\n").at(-1);
      expect(candidate).toMatch(/^[0-9a-f]{40}$/);
      if (candidate === undefined) throw new TypeError("candidate commit was not reported");

      await stopWorkspace(runner, options, workspaceName);
      await startWorkspace(runner, options, workspaceName);
      await assertCheckout(agent, candidate);
      await restartWorkspace(runner, options, workspaceName);
      await assertCheckout(agent, candidate);
      await updateWorkspace(runner, options, workspaceName);
      await assertCheckout(agent, candidate);

      const state = new LifecycleState(fixture.stateRoot);
      await expect(state.readWorkspace(workspaceName)).resolves.toMatchObject({
        schemaVersion: 9,
        phase: "ready",
        source: { kind: "native" }
      });
    } catch (error) {
      primaryFailure = error;
    }

    const failures: unknown[] = [];
    if (await exists(join(fixture.stateRoot, "workspaces", `${workspaceName}.json`))) {
      try {
        await discardWorkspace(runner, options, workspaceName);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const server of controllers.toReversed()) {
      try {
        await close(server);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await plugins.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanupNativeProjectFixtures();
    } catch (error) {
      failures.push(error);
    }
    if (imageBuilt) {
      const removed = await runner.run("docker", ["image", "rm", image]);
      if (removed.exitCode !== 0) failures.push(new TypeError(`workspace image cleanup failed: ${removed.stderr}`));
    }
    if (failures.length > 0) {
      await writeCleanupUncertaintySentinel();
      throw nativeLifecycleFailure(primaryFailure, failures);
    }
    if (primaryFailure !== undefined) throw primaryFailure;
  }, 420_000);
});

const candidateScript = `
set -euo pipefail
proposal="$1"
protected="$2"
git config user.name 'DIM native lifecycle'
git config user.email 'native-lifecycle@dim.invalid'
git switch -c native-basic >/dev/null
printf 'native-basic\n' >native-basic-lifecycle.txt
git add native-basic-lifecycle.txt
git commit -m 'native basic lifecycle' >/dev/null
candidate="$(git rev-parse HEAD)"
git push origin "HEAD:$proposal" >/dev/null
if git push origin HEAD:refs/heads/main; then exit 41; fi
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$protected"
test "$(git ls-remote origin "$proposal" | cut -f1)" = "$candidate"
printf '%s\n' "$candidate"
`;

async function assertWorkspaceVerificationCapabilities(agent: string): Promise<void> {
  const result = await runner.run("docker", [
    "exec", "--user", "dim", agent, "bash", "-lc",
    'set -euo pipefail; test ! -e /dev/kvm; test ! -e /run/dim/qemu-verification; test -z "${DIM_QEMU_VERIFICATION_SOCKET:-}"; docker info >/dev/null; printf "private-docker=ready direct-kvm=absent default-qemu-broker=absent\\n"'
  ], { signal: AbortSignal.timeout(30_000) });
  if (result.exitCode !== 0) throw nativeLifecycleCommandFailure("workspace verification capabilities", result);
  expect(result.stdout.trim()).toBe("private-docker=ready direct-kvm=absent default-qemu-broker=absent");
  process.stdout.write(`native-workspace-verification ${result.stdout}`);
}

async function assertCheckout(agent: string, candidate: string): Promise<void> {
  const result = await runner.run("docker", [
    "exec", "--user", "dim", "--workdir", "/workspace", agent,
    "bash", "-lc", "test -f native-basic-lifecycle.txt && git rev-parse HEAD"
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe(candidate);
}

async function listen(server: Server | undefined, socketPath: string): Promise<void> {
  if (server === undefined) throw new TypeError("controller server is missing");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeCleanupUncertaintySentinel(): Promise<void> {
  const path = process.env.DIM_NATIVE_BASIC_LIFECYCLE_CLEANUP_SENTINEL;
  if (path === undefined) return;
  await writeFile(path, "cleanup uncertain\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function projectControllerScopeHostMirror(stateRoot: string): Promise<void> {
  const hostOptions = { ...lifecycleOptionsForBackend("sysbox", {
    DIM_STATE_ROOT: process.env.DIM_STATE_ROOT
  }), hostMirrorProvider };
  await ensureRegistryCache(runner, hostOptions);
  await ensureAptCache(runner, hostOptions);
  const ownership = await new LifecycleState(hostOptions.stateRoot).readHostMirrorOwnership();
  if (ownership === undefined) throw new TypeError("host mirror ownership was not recorded");
  await new LifecycleState(stateRoot).writeHostMirrorOwnership(ownership);
}
