import { describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";

describe("lifecycle options", () => {
  it("uses discoverable sockets for the default state root", () => {
    const options = lifecycleOptionsForBackend("runc", {
      HOME: "/home/developer",
      XDG_RUNTIME_DIR: "/run/user/1000"
    });

    expect(options.controllerSocketPath).toBe("/run/user/1000/dim/controller.sock");
    expect(options.adminControllerSocketPath).toBe("/run/user/1000/dim/admin.sock");
    expect(options.gitMaintainerUsername).toBe("dim-host");
  });

  it("namespaces sockets for a custom state root", () => {
    const options = lifecycleOptionsForBackend("runc", {
      HOME: "/home/developer",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DIM_STATE_ROOT: "/tmp/alternate-dim-state"
    });

    expect(options.adminControllerSocketPath).toMatch(
      /^\/run\/user\/1000\/dim\/[a-f0-9]{16}\/admin\.sock$/
    );
  });

  it("uses the remote TCP Docker host for host-facing Gitea traffic", () => {
    const options = lifecycleOptionsForBackend("runc", {
      HOME: "/home/developer",
      DOCKER_HOST: "tcp://agent-dind:2375"
    });

    expect(options.giteaHost).toBe("agent-dind");
  });
});
