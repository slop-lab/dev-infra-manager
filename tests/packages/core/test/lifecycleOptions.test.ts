import { describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";

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

  it("selects native Project lifecycle through an explicit control-plane connection", () => {
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: "/run/secrets/dim-native-control.json"
    });

    expect(options.nativeControlPlaneConnection).toEqual({
      file: "/run/secrets/dim-native-control.json"
    });
  });

  it.each([
    "DIM_GITEA_CONNECTION_FILE",
    "DIM_GIT_SYNC_CONNECTION_FILE",
    "DIM_QEMU_SCHEDULER_CONNECTION_FILE",
    "DIM_ORDINARY_CI_POOL_CONNECTION_FILE"
  ])("rejects obsolete %s even when its value is empty", (selector) => {
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      [selector]: ""
    })).toThrow(new RegExp(`${selector} is not supported by the native-only lifecycle`));
  });

  it("rejects an empty native control-plane selector", () => {
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: ""
    })).toThrow(/DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE must name an absolute connection file/);
  });

  it("rejects native QEMU before selecting Gitea while that adapter is unavailable", () => {
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_NATIVE_QEMU_CONNECTION_FILE: "/run/secrets/dim-native-qemu.json"
    })).toThrow(/native QEMU adapter is unavailable; refusing fallback/);
  });
});
