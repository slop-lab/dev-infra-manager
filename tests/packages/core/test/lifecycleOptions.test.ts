import { describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { SYSBOX_CI_RUNNER_IMAGE } from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";

describe("lifecycle options", () => {
  it("uses discoverable sockets for the default state root", () => {
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      XDG_RUNTIME_DIR: "/run/user/1000"
    });

    expect(options.controllerRuntimeDirectory).toBe("/run/user/1000/dim");
    expect(options.controllerSocketPath).toBe("/run/user/1000/dim/workspace/controller.sock");
    expect(options.agentControllerSocketPath).toBe("/run/user/1000/dim/agent/controller.sock");
    expect(options.adminControllerSocketPath).toBe("/run/user/1000/dim/admin/controller.sock");
    expect(options.gitMaintainerUsername).toBe("dim-host");
    expect(options.ciRunnerImage).toBe(SYSBOX_CI_RUNNER_IMAGE);
  });

  it("namespaces sockets for a custom state root", () => {
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DIM_STATE_ROOT: "/tmp/alternate-dim-state"
    });

    expect(options.adminControllerSocketPath).toMatch(
      /^\/run\/user\/1000\/dim\/[a-f0-9]{16}\/admin\/controller\.sock$/
    );
  });

  it("uses the remote TCP Docker host for host-facing Gitea traffic", () => {
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DOCKER_HOST: "tcp://agent-dind:2375"
    });

    expect(options.giteaHost).toBe("agent-dind");
  });

  it("selects external Gitea only through an explicit connection file", () => {
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: "/run/secrets/dim-gitea.json"
    });

    expect(options.giteaConnection).toEqual({
      kind: "external",
      file: "/run/secrets/dim-gitea.json"
    });
  });

  it("selects Git-host synchronization only through an explicit connection file", () => {
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GIT_SYNC_CONNECTION_FILE: "/run/secrets/dim-git-sync.json"
    });

    expect(options.gitSyncConnection).toEqual({
      file: "/run/secrets/dim-git-sync.json"
    });
  });

  it("selects native Project lifecycle through an explicit control-plane connection", () => {
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: "/run/secrets/dim-native-control.json"
    });

    expect(options.nativeControlPlaneConnection).toEqual({
      file: "/run/secrets/dim-native-control.json"
    });
    expect(options.giteaConnection).toEqual({ kind: "disabled" });
  });

  it.each([
    "DIM_GITEA_CONNECTION_FILE",
    "DIM_GIT_SYNC_CONNECTION_FILE",
    "DIM_QEMU_SCHEDULER_CONNECTION_FILE",
    "DIM_ORDINARY_CI_POOL_CONNECTION_FILE"
  ])("rejects native lifecycle combined with %s before resolving paths", (selector) => {
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: "/missing/native.json",
      [selector]: "/missing/predecessor.json"
    })).toThrow(new RegExp(`${selector} cannot be combined with native control-plane selection`));
  });

  it("rejects an importer selector without native lifecycle selection", () => {
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: "/run/secrets/dim-native-importer.json"
    })).toThrow(/DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE requires native control-plane selection/);
  });

  it.each([
    "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE",
    "DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE"
  ])("rejects an empty %s selector", (selector) => {
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      [selector]: ""
    })).toThrow(new RegExp(`${selector} must name an absolute connection file`));
  });

  it("rejects native QEMU before selecting Gitea while that adapter is unavailable", () => {
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_NATIVE_QEMU_CONNECTION_FILE: "/run/secrets/dim-native-qemu.json"
    })).toThrow(/native QEMU adapter is unavailable; refusing fallback/);
  });
});
