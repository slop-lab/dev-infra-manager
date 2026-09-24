import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const richExamples = ["multi-repository", "full-development-flow"] as const;

describe("rich example nested topology policy", () => {
  it.each(richExamples)("keeps only agent and secure daemons in the outer graph for %s", async (example) => {
    // Given
    const root = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim");

    // When
    const compose = parse(await readFile(resolve(root, "docker-compose.yml"), "utf8"));
    const secureCompose = parse(await readFile(resolve(root, "secure-compose.yml"), "utf8"));

    // Then
    expect(compose.include).toEqual(["secure-compose.yml"]);
    expect([...Object.keys(compose.services), ...Object.keys(secureCompose.services)].sort()).toEqual([
      "agent-dind",
      "secure-dind"
    ]);
    expect(secureCompose.services["secure-dind"].profiles).toEqual(["secure"]);
    expect(JSON.stringify({ compose, secureCompose })).not.toContain("2375");
    expect(JSON.stringify({ compose, secureCompose })).not.toContain("/var/run/docker.sock");
  });

  it.each(richExamples)("launches the agent on its daemon's private Unix socket for %s", async (example) => {
    // Given
    const root = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim");

    // When
    const launcher = await readFile(resolve(root, "agent-dind/agent.sh"), "utf8");
    const entrypoint = await readFile(resolve(root, "entrypoint.sh"), "utf8");
    const setup = await readFile(resolve(root, "setup.sh"), "utf8");

    // Then
    expect(launcher).toContain('agent_name="dim-agent"');
    expect(launcher).toContain("DOCKER_HOST=unix:///run/dim-agent-dind/docker.sock");
    expect(launcher).toContain("DIM_EXTERNAL_URL_CONTAINERS_JSON");
    expect(launcher).toContain('["agent-dind","dim-agent"]');
    expect(entrypoint).toContain("agent-dind dim-agent-dind exec");
    expect(setup).toContain('--bind-containers-json \'["agent-dind","dim-agent"]\'');
  });

  it.each(richExamples)("starts each private daemon with one Unix listener for %s", async (example) => {
    // Given
    const root = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim");

    // When
    const agentEntrypoint = await readFile(resolve(root, "agent-dind/entrypoint.sh"), "utf8");
    const secureEntrypoint = await readFile(resolve(root, "secure-dind/entrypoint.sh"), "utf8");

    // Then
    expect(agentEntrypoint).toContain('dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"');
    expect(secureEntrypoint).toContain('dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"');
    expect(`${agentEntrypoint}\n${secureEntrypoint}`).not.toContain('dockerd-entrypoint.sh "$@"');
  });

  it.each(richExamples)("initializes persistent agent homes without recursive ownership rewrites for %s", async (example) => {
    const root = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim");
    const entrypoint = await readFile(resolve(root, "agent-dind/entrypoint.sh"), "utf8");
    const initializer = await readFile(
      resolve(root, example === "multi-repository" ? "agent-dind/agent.sh" : "agent/start-sshd.sh"),
      "utf8"
    );
    const image = await readFile(resolve(root, "agent/Dockerfile"), "utf8");

    expect(entrypoint).toContain("/etc/subuid");
    expect(entrypoint).toContain("mapped_agent_uid=$((subuid_start + DIM_WORKSPACE_UID - 1))");
    expect(entrypoint).toContain("mapped_agent_gid=$((subgid_start + DIM_WORKSPACE_GID - 1))");
    expect(entrypoint).toContain('prepare_persistent_root "$docker_data" "$rootless_owner"');
    expect(entrypoint).toContain('prepare_persistent_root /mnt/agent-home "$mapped_agent_owner"');
    expect(entrypoint).toContain("incompatible ownership or mode");
    expect(entrypoint).not.toMatch(/chown\s+-R/);
    expect(initializer).toContain("chown dim-agent:dim-agent /home/dim-agent");
    expect(initializer).not.toMatch(/chown\s+-R\s+dim-agent:dim-agent\s+\/home\/dim-agent/);
    expect(image).toMatch(/apt-get install[^\n]*[\s\S]*?\bacl\b/);
  });

  it.each(richExamples)("reconciles removed optional profiles for %s", async (example) => {
    // Given
    const root = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim");

    // When
    const setup = await readFile(resolve(root, "setup.sh"), "utf8");
    const agent = await readFile(resolve(root, "agent-dind/agent.sh"), "utf8");

    // Then
    expect(setup).toContain("--profile secure stop secure-dind");
    expect(setup).toContain("--profile secure up --detach --force-recreate --wait --wait-timeout 60 secure-dind");
    expect(setup).toContain("dim-agent-dind clear-documentation");
    expect(agent).toContain("clear-documentation)");
  });

  it.each(richExamples)("launches secret workloads in isolated secure storage for %s", async (example) => {
    // Given
    const project = resolve(workspaceRoot, "examples/projects", example);
    const root = resolve(project, "repos/root");

    // When
    const compose = await readFile(resolve(root, ".dim/docker-compose.yml"), "utf8");
    const secureComposePath = resolve(root, ".dim/secure-compose.yml");
    const secureCompose = parse(await readFile(secureComposePath, "utf8"));
    const launcher = await readFile(resolve(root, ".dim/secure-dind/service.sh"), "utf8");
    const operations = await readFile(resolve(root, "ops/secret-service.sh"), "utf8");
    const deployment = await readFile(resolve(project, "deploy-secret.bash"), "utf8");

    // Then
    expect(await readFile(secureComposePath, "utf8")).toContain("secure-dind-data:");
    expect(Object.keys(secureCompose.services)).toEqual(["secure-dind"]);
    expect(Object.keys(secureCompose.volumes)).toEqual(["secure-dind-data"]);
    expect(JSON.stringify(secureCompose)).not.toContain("GIT_AUTHOR_");
    expect(JSON.stringify(secureCompose)).not.toContain("GIT_COMMITTER_");
    expect(compose).not.toContain("EXAMPLE_SECRET:");
    expect(launcher).toContain('service_name="dim-secret-service"');
    expect(launcher).toContain('--publish 7099:7099');
    expect(operations).toContain("secure-dind dim-secure-dind deploy");
    expect(operations).toContain("tar --exclude=.git -C \"$checkout\" -cf - .");
    expect(operations).toContain('immutable_root="${DIM_PROJECT_ROOT:?DIM_PROJECT_ROOT is required}"');
    expect(operations).toContain('cd "$immutable_root"');
    expect(operations).toContain('--file "$immutable_root/.dim/secure-compose.yml"');
    expect(deployment).toContain('sh "$DIM_PROJECT_ROOT/ops/secret-service.sh" deploy-secret');
  });
});
