import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const selfDim = resolve(root, ".dim");
const fullDim = resolve(root, "examples/projects/full-development-flow/repos/root/.dim");
const singleDim = resolve(root, "examples/projects/single-repository/repos/app/.dim");

describe("workspace resource proxy Project wiring", () => {
  it("wires the self Project resource proxy through the nested agent and SSH environment", async () => {
    // Given
    const setup = await readFile(resolve(selfDim, "setup.sh"), "utf8");
    const compose = await readFile(resolve(selfDim, "docker-compose.yml"), "utf8");
    const launcher = await readFile(resolve(selfDim, "agent-dind/agent.sh"), "utf8");
    const ssh = await readFile(resolve(root, "agent/start-sshd.sh"), "utf8");

    // When
    const combined = `${setup}\n${compose}\n${launcher}\n${ssh}`;

    // Then
    expect(setup).toContain("--allow-workspace-resources");
    expect(compose).toContain("/tmp/dim-agent-controller:/run/dim/controller-proxy:ro");
    expect(launcher).toContain("--env DIM_AGENT_CONTROLLER_SOCKET=/run/dim/controller-proxy/resources.sock");
    expect(launcher).toContain("src=/run/dim/controller-proxy,dst=/run/dim/controller-proxy,readonly");
    expect(ssh).toMatch(/^\s+DIM_AGENT_CONTROLLER_SOCKET$/m);
    expect(combined).not.toContain("DIM_AGENT_CONTROLLER_TOKEN=/run/");
  });

  it("keeps full-flow restart and resource proxies on separate derived sockets", async () => {
    // Given
    const setup = await readFile(resolve(fullDim, "setup.sh"), "utf8");
    const launcher = await readFile(resolve(fullDim, "agent-dind/agent.sh"), "utf8");
    const image = await readFile(resolve(fullDim, "agent/Dockerfile"), "utf8");
    const ssh = await readFile(resolve(fullDim, "agent/start-sshd.sh"), "utf8");

    // When
    const proxyStarts = setup.match(/dim-controller-proxy agent \\/g) ?? [];

    // Then
    expect(proxyStarts).toHaveLength(2);
    expect(setup).toContain('resource_proxy_socket="$proxy_dir/resources.sock"');
    expect(setup).toContain("--allow-workspace-restart");
    expect(setup).toContain("--allow-workspace-resources");
    expect(launcher).toContain("--env DIM_CONTROLLER_SOCKET=/run/dim/controller-proxy/agent.sock");
    expect(launcher).toContain("--env DIM_AGENT_CONTROLLER_SOCKET=/run/dim/controller-proxy/resources.sock");
    expect(image).toContain("/usr/local/bin/dim-workspace-resources");
    expect(image).toContain("/usr/local/bin/dim-nproc");
    expect(ssh).toMatch(/^\s+DIM_CONTROLLER_SOCKET$/m);
    expect(ssh).toMatch(/^\s+DIM_AGENT_CONTROLLER_SOCKET$/m);
  });

  it("exposes separate restart and resource sockets in the single-repository agent", async () => {
    // Given
    const setup = await readFile(resolve(singleDim, "setup.sh"), "utf8");
    const compose = await readFile(resolve(singleDim, "docker-compose.yml"), "utf8");
    const image = await readFile(resolve(singleDim, "agent/Dockerfile"), "utf8");
    const smoke = await readFile(resolve(root, "verification/scripts/single-repository-example-smoke.bash"), "utf8");

    // When
    const proxyStarts = setup.match(/dim-controller-proxy agent \\/g) ?? [];

    // Then
    expect(proxyStarts).toHaveLength(2);
    expect(setup).toContain("--allow-workspace-restart");
    expect(setup).toContain("--allow-workspace-resources");
    expect(compose).toContain('DIM_CONTROLLER_SOCKET: "/run/dim/controller-proxy/agent.sock"');
    expect(compose).toContain('DIM_AGENT_CONTROLLER_SOCKET: "/run/dim/controller-proxy/resources.sock"');
    expect(image).toContain("/usr/local/bin/dim-workspace-resources");
    expect(image).toContain("/usr/local/bin/dim-nproc");
    expect(smoke).toContain('dim-workspace-resources show');
    expect(smoke).toContain('test "$(dim-nproc)" = 2');
  });
});
