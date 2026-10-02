import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const runtimeRoot = resolve(
  workspaceRoot,
  "examples/projects/full-development-flow/repos/root/.dim",
);
const agentRoot = resolve(runtimeRoot, "agent");

describe("full-development-flow agent temporary volume policy", () => {
  it("gives OpenCode a dedicated persistent TMPDIR", async () => {
    const [launcher, dockerfile, entrypoint, dindEntrypoint, compose, setup] = await Promise.all([
      readFile(resolve(runtimeRoot, "agent-dind/agent.sh"), "utf8"),
      readFile(resolve(agentRoot, "Dockerfile"), "utf8"),
      readFile(resolve(agentRoot, "start-sshd.sh"), "utf8"),
      readFile(resolve(runtimeRoot, "agent-dind/entrypoint.sh"), "utf8"),
      readFile(resolve(runtimeRoot, "docker-compose.yml"), "utf8"),
      readFile(resolve(runtimeRoot, "setup.sh"), "utf8"),
    ]);

    expect(launcher).toContain("--env TMPDIR=/mnt/opencode-tmp");
    expect(launcher).toContain("--mount type=bind,src=/mnt/agent-tmp,dst=/mnt/opencode-tmp");
    expect(launcher).not.toContain("docker volume");
    expect(launcher).not.toContain("TMPDIR=/tmp");
    expect(launcher).not.toContain("dst=/tmp");
    expect(compose).toContain("agent-tmp:/mnt/agent-tmp");
    expect(compose).toContain("dev.dim.role: agent-tmp");
    expect(dindEntrypoint).toContain(
      'prepare_persistent_root /mnt/agent-tmp "$mapped_agent_owner" 700 "agent temporary storage"',
    );
    expect(setup.indexOf("create --force-recreate agent-dind")).toBeLessThan(
      setup.indexOf('sh .dim/agent-tmp-volume.sh prepare "$agent_dind_id"'),
    );
    expect(setup.indexOf('sh .dim/agent-tmp-volume.sh prepare "$agent_dind_id"')).toBeLessThan(
      setup.indexOf("up --detach --wait --wait-timeout 60 agent-dind"),
    );
    expect(dockerfile).toContain("prepare-agent-tmp.sh /usr/local/bin/prepare-agent-tmp");
    expect(entrypoint).toContain("  TMPDIR");
    expect(entrypoint).toContain('runuser -u dim-agent -- touch "$tmp_probe"');
  });

  it("validates ownership and mode before mounting TMPDIR", async () => {
    const helper = await readFile(resolve(agentRoot, "prepare-agent-tmp.sh"), "utf8");

    expect(helper).toContain('test ! -L "$agent_tmpdir"');
    expect(helper).toContain('stat -c %u:%g "$agent_tmpdir"');
    expect(helper).toContain('stat -c %a "$agent_tmpdir"');
    expect(helper).toContain("has incompatible ownership or mode");
    expect(helper).not.toMatch(/chown\s+-R|chmod\s+-R|rm\s+-rf/);
  });

  it("removes only the owned TMPDIR volume in both discard modes", async () => {
    const [launcher, teardown, lifecycle] = await Promise.all([
      readFile(resolve(runtimeRoot, "agent-dind/agent.sh"), "utf8"),
      readFile(resolve(runtimeRoot, "teardown.sh"), "utf8"),
      readFile(resolve(runtimeRoot, "agent-tmp-volume.sh"), "utf8"),
    ]);

    expect(launcher).not.toContain("discard-agent-tmp)");
    expect(teardown).toContain("ps --all --quiet agent-dind");
    expect(teardown).toContain('sh .dim/agent-tmp-volume.sh discard "$agent_dind_id"');
    expect(teardown).toMatch(/\ndiscard_agent_tmp\n/);
    expect(teardown).not.toContain('test "$keep_volumes" = 1 || discard_agent_tmp');
    expect(lifecycle).toContain('test "$volume_driver" = local');
    expect(lifecycle).toContain('test "$volume_options" = null');
    expect(lifecycle).toContain('test "$home_driver" = local');
    expect(lifecycle).toContain('test "$home_options" = null');
    expect(lifecycle).toContain('test "$home_project" = "$project"');
    expect(lifecycle).toContain('test "$home_logical_name" = agent-home');
    expect(lifecycle).toContain('test "$tmp_volume" != "$home_volume"');
    expect(lifecycle).toContain('docker rm --force "$agent_dind_id"');
    expect(lifecycle).toContain('docker volume rm "$tmp_volume"');
  });
});
