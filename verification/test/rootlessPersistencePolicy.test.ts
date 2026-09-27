import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("self-development rootless persistence policy", () => {
  it("preserves persistent agent-home ownership and modes during setup", async () => {
    const [agent, entrypoint, compose, workspaceChecks] = await Promise.all([
      readFile(resolve(workspaceRoot, ".dim/agent-dind/agent.sh"), "utf8"),
      readFile(resolve(workspaceRoot, ".dim/agent-dind/entrypoint.sh"), "utf8"),
      readFile(resolve(workspaceRoot, ".dim/docker-compose.yml"), "utf8"),
      readFile(
        resolve(workspaceRoot, "verification/scripts/lib/container-self-project-workspace-checks.bash"),
        "utf8"
      ),
    ]);

    expect(agent).not.toMatch(/chown[^\n]*\/mnt\/agent-home/);
    expect(entrypoint).toContain('subuid_start="$(awk -F: \'$1 == "rootless" { print $2; exit }\' /etc/subuid)"');
    expect(entrypoint).toContain("mapped_agent_uid=$((subuid_start + DIM_AGENT_UID - 1))");
    expect(entrypoint).toContain('prepare_persistent_root /mnt/agent-home "$mapped_agent_owner" 700 "agent home"');
    expect(compose).toContain('DIM_WORKSPACE_UID: "${DIM_WORKSPACE_UID:?}"');
    expect(compose).toContain('DIM_WORKSPACE_GID: "${DIM_WORKSPACE_GID:?}"');
    expect(compose).toContain('DIM_AGENT_UID: "1000"');
    expect(agent).toContain('--build-arg DIM_AGENT_UID="$DIM_AGENT_UID"');
    expect(agent).toContain("--env CI=1");
    expect(workspaceChecks).toContain(
      'mapped_home_owner="$((subuid_start + DIM_AGENT_UID - 1)):$((subgid_start + DIM_AGENT_UID - 1))"'
    );
    expect(workspaceChecks).toContain('docker exec --user root "$agent_dind_container"');
    expect(workspaceChecks).toContain('cat > /tmp/dim-self-qemu-client.mjs');
    expect(workspaceChecks).toContain("node /tmp/dim-self-qemu-client.mjs probe");
    expect(workspaceChecks).toContain("/run/dim/project-root/.dim/docker-compose.yml");
    expect(workspaceChecks).toContain("/run/dim/project-root/.dim/kvm.sh");
    expect(workspaceChecks).not.toContain("--file .dim/docker-compose.yml");
    expect(workspaceChecks).not.toContain("-- sh .dim/kvm.sh");
  });

  it("rejects incompatible persistent roots without recursively rewriting them", async () => {
    const entrypoints = await Promise.all(
      ["agent-dind", "secure-dind"].map((service) =>
        readFile(resolve(workspaceRoot, `.dim/${service}/entrypoint.sh`), "utf8")
      )
    );

    for (const entrypoint of entrypoints) {
      expect(entrypoint).not.toMatch(/chown\s+-R/);
      expect(entrypoint).toContain("incompatible ownership");
      expect(entrypoint).not.toContain("runtime-runc");
      expect(entrypoint).not.toMatch(/rm\s+-rf/);
    }
  });

  it("repairs and preserves setuid ownership for rootless idmap helpers", async () => {
    const entrypoints = await Promise.all(
      ["agent-dind", "secure-dind"].map((service) =>
        readFile(resolve(workspaceRoot, `.dim/${service}/entrypoint.sh`), "utf8")
      )
    );

    for (const entrypoint of entrypoints) {
      expect(entrypoint).toContain("chown root:root /usr/bin/newuidmap /usr/bin/newgidmap");
      expect(entrypoint).toContain("chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap");
    }
  });

  it("restores agent home outside the helper image rootless Docker volume", async () => {
    const [dockerfile, archive] = await Promise.all([
      readFile(resolve(workspaceRoot, ".dim/agent-dind/Dockerfile"), "utf8"),
      readFile(resolve(workspaceRoot, ".dim/home-archive.sh"), "utf8"),
    ]);

    expect(dockerfile).toContain("mkdir -p /mnt/agent-home /mnt/workspace-shared-dind");
    expect(archive).toContain('dst=/mnt/agent-home');
    expect(archive).toContain("tar -C /mnt/agent-home");
    expect(archive).not.toContain('dst=/home');
    expect(archive).not.toContain("tar -C /home");
  });
});