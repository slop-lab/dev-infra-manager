import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceContainerArgs } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { hostLifecycleOptions, workspaceRecord } from "./hostLifecycleFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native workspace container", () => {
  it("builds a persistent container with brokered Git and no host runtime socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-lifecycle-container-"));
    roots.push(root);
    const options = { ...hostLifecycleOptions(root), workspaceRuntime: "runc", workspacePrivileged: true };
    const record = { ...workspaceRecord("work-1", "creating"), kvm: true, cpuCount: "1.5",
      memory: "3g", pidsLimit: "1024", capabilities: [{ name: "writable-cgroup",
        requirement: "required" as const, status: "provided" as const, plugin: "capability-plugin",
        capabilities: ["SYS_ADMIN"], securityOptions: ["seccomp=unconfined"], devices: ["/dev/fuse"],
        environment: { DIM_WRITABLE_CGROUP: "1" } }] };

    const args = workspaceContainerArgs(options, record, {
      username: "dim", token: "", userName: "Agent", userEmail: "agent@example.invalid",
      brokerToken: "native-git-grant"
    }, "work-1.controller-grant", () => 992, "work-1.agent.agent-grant");

    expect(args).toEqual(expect.arrayContaining([
      "--name", "dim-ws-work-1",
      "--label", "dim.runtime-config=9",
      "--mount", `type=bind,source=${join(root, "assets", "native-project-roots", "project-id", "a".repeat(40))},target=/run/dim/project-root,readonly`,
      "--env", "DIM_NATIVE_GIT_BROKER_TOKEN=native-git-grant",
      "--cap-add", "SYS_ADMIN",
      "--device", "/dev/kvm",
      "--privileged"
    ]));
    expect(args).not.toContain("--rm");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("DIM_ADMIN_CONTROLLER_SOCKET");

    const withoutKvm = workspaceContainerArgs(options, { ...record, kvm: false }, {
      username: "dim", token: "", userName: "Agent", userEmail: "agent@example.invalid",
      brokerToken: "native-git-grant"
    }, "work-1.controller-grant", () => 992, "work-1.agent.agent-grant");
    expect(withoutKvm).not.toContain("/dev/kvm");
    expect(withoutKvm).not.toContain("--group-add");
  });
});
