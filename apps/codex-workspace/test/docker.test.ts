import { describe, expect, it } from "vitest";
import { canEnterRunningContainer, dockerExecArgs, dockerRunArgs, timedCommand, type WorkspaceOptions } from "../src/docker.js";

const options: WorkspaceOptions = {
  name: "repo", workspace: "/src/repo", stateRoot: "/state", image: "codex:test",
  cpus: "2", memory: "4g", pids: "1024", runtime: "sysbox-runc", timeoutSeconds: 900
};

describe("Codex workspace Docker boundary", () => {
  it("mounts only the worktree and dedicated state", () => {
    const args = dockerRunArgs(options, ["codex", "--version"], false);
    expect(args).toEqual(expect.arrayContaining(["--runtime", "sysbox-runc", "--cpus", "2", "--memory", "4g", "--pids-limit", "1024"]));
    expect(args.join(" ")).toContain("source=/src/repo,target=/workspace");
    expect(args.join(" ")).toContain("source=/state/codex-workspaces/repo/home,target=/home/agent");
    expect(args.join(" ")).toContain("source=/state/codex-workspaces/repo/inner-docker,target=/var/lib/docker");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(timedCommand(options, args)).toEqual(["timeout", expect.arrayContaining(["900s", "docker"])]);
  });

  it("opens workspace processes in an existing named container", () => {
    expect(canEnterRunningContainer("shell")).toBe(true);
    expect(canEnterRunningContainer("login")).toBe(true);
    expect(canEnterRunningContainer("run")).toBe(true);
    expect(canEnterRunningContainer("doctor")).toBe(false);
    expect(dockerExecArgs("repo", ["bash"], true)).toEqual([
      "exec", "--interactive", "--tty", "dim-codex-repo", "bash"
    ]);
    expect(dockerExecArgs("repo", ["codex", "login"], false)).toEqual([
      "exec", "dim-codex-repo", "codex", "login"
    ]);
    expect(dockerExecArgs("repo", ["codex", "--dangerously-bypass-approvals-and-sandbox"], false)).toEqual([
      "exec", "dim-codex-repo", "codex", "--dangerously-bypass-approvals-and-sandbox"
    ]);
  });
});
