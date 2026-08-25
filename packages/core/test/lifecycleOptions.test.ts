import { describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { SYSBOX_CI_RUNNER_IMAGE } from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";

describe("lifecycle options", () => {
  it("uses discoverable sockets for the default state root", () => {
    const options = lifecycleOptionsForBackend("runc", {
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
    const options = lifecycleOptionsForBackend("runc", {
      HOME: "/home/developer",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DIM_STATE_ROOT: "/tmp/alternate-dim-state"
    });

    expect(options.adminControllerSocketPath).toMatch(
      /^\/run\/user\/1000\/dim\/[a-f0-9]{16}\/admin\/controller\.sock$/
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
