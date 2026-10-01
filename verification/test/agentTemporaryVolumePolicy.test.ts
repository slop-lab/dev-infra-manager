import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const runtimeRoot = resolve(workspaceRoot, ".dim");
const agentRoot = resolve(workspaceRoot, "agent");

describe("self-Project agent temporary volume policy", () => {
  it("gives OpenCode a dedicated persistent TMPDIR", async () => {
    const [launcher, dockerfile, entrypoint] = await Promise.all([
      readFile(resolve(runtimeRoot, "agent-dind/agent.sh"), "utf8"),
      readFile(resolve(agentRoot, "Dockerfile"), "utf8"),
      readFile(resolve(agentRoot, "start-sshd.sh"), "utf8"),
    ]);

    expect(launcher).toContain('agent_tmp_volume="dim-agent-tmp"');
    expect(launcher).toContain("--label dev.dim.role=agent-tmp");
    expect(launcher).toContain("--env TMPDIR=/tmp/opencode");
    expect(launcher).toContain('--mount type=volume,src="$agent_tmp_volume",dst=/tmp/opencode');
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

  it("removes only the owned TMPDIR volume on ordinary discard", async () => {
    const [launcher, teardown] = await Promise.all([
      readFile(resolve(runtimeRoot, "agent-dind/agent.sh"), "utf8"),
      readFile(resolve(runtimeRoot, "teardown.sh"), "utf8"),
    ]);

    expect(launcher).toContain("discard-agent-tmp)");
    expect(launcher).toContain("dev.dim.role=agent-tmp");
    expect(launcher).toContain('docker volume rm "$agent_tmp_volume"');
    expect(teardown).toContain("dim-agent-dind discard-agent-tmp");
    expect(teardown).toContain('test "$keep_volumes" = 1 ||');
  });
});
