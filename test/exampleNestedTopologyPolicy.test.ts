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

    // Then
    expect(Object.keys(compose.services).sort()).toEqual(["agent-dind", "secure-dind"]);
    expect(compose.services["secure-dind"].profiles).toEqual(["secure"]);
    expect(JSON.stringify(compose)).not.toContain("2375");
    expect(JSON.stringify(compose)).not.toContain("/var/run/docker.sock");
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

  it.each(richExamples)("launches secret workloads in isolated secure storage for %s", async (example) => {
    // Given
    const project = resolve(workspaceRoot, "examples/projects", example);
    const root = resolve(project, "repos/root");

    // When
    const compose = await readFile(resolve(root, ".dim/docker-compose.yml"), "utf8");
    const launcher = await readFile(resolve(root, ".dim/secure-dind/service.sh"), "utf8");
    const operations = await readFile(resolve(root, "ops/secret-service.sh"), "utf8");

    // Then
    expect(compose).toContain("secure-dind-data:");
    expect(compose).not.toContain("EXAMPLE_SECRET:");
    expect(launcher).toContain('service_name="dim-secret-service"');
    expect(launcher).toContain('--publish 7099:7099');
    expect(operations).toContain("secure-dind dim-secure-dind deploy");
    expect(operations).toContain("tar --exclude=.git -C \"$checkout\" -cf - .");
  });
});
