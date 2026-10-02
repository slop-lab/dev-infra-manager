import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const selfDim = resolve(root, ".dim");

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

});
