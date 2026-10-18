import { describe, expect, it } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/managed/src/lifecycleOptions.js";

describe("lifecycle options", () => {
  it("uses discoverable sockets for the default state root", () => {
    const options = lifecycleOptions({
      HOME: "/home/developer",
      XDG_RUNTIME_DIR: "/run/user/1000"
    });

    expect(options.stateRoot).toBe("/home/developer/.local/state/dim/managed");
    expect(options.controllerRuntimeDirectory).toBe("/run/user/1000/dim/managed");
    expect(options.controllerSocketPath).toBe("/run/user/1000/dim/managed/workspace/controller.sock");
    expect(options.adminControllerSocketPath).toBe("/run/user/1000/dim/managed/admin/controller.sock");
  });

  it("namespaces sockets for a custom state root", () => {
    const options = lifecycleOptions({
      HOME: "/home/developer",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DIM_STATE_ROOT: "/tmp/alternate-dim-state"
    });

    expect(options.adminControllerSocketPath).toMatch(
      /^\/run\/user\/1000\/dim\/managed\/[a-f0-9]{16}\/admin\/controller\.sock$/
    );
  });

  it("prefers an explicit managed state root over the base state root", () => {
    const options = lifecycleOptions({
      HOME: "/home/developer", DIM_STATE_ROOT: "/tmp/base", DIM_MANAGED_STATE_ROOT: "/tmp/managed"
    });
    expect(options.stateRoot).toBe("/tmp/managed");
  });

  it("resolves optional service paths without backend or native Git configuration", () => {
    const options = lifecycleOptions({ HOME: "/home/developer", DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: "" });
    expect(options.stateRoot).toBe("/home/developer/.local/state/dim/managed");
    expect(options.adminControllerSocketPath).toContain("/dim/managed/admin/controller.sock");
  });
});
