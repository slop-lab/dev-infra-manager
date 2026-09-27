import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const richExamples = ["multi-repository", "full-development-flow"] as const;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prepareTools(hostnameOutput: string): Promise<Readonly<{ calls: string; path: string }>> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-agent-relay-test-"));
  fixtureRoots.push(root);
  const tools = resolve(root, "tools");
  const calls = resolve(root, "docker.calls");
  await mkdir(tools);
  await writeFile(
    resolve(tools, "docker"),
    `#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >>"$DIM_TEST_DOCKER_CALLS"
`
  );
  await writeFile(
    resolve(tools, "hostname"),
    `#!/usr/bin/env sh
set -eu
printf '%s\n' "$DIM_TEST_HOSTNAME_OUTPUT"
`
  );
  await writeFile(resolve(tools, "jq"), "#!/usr/bin/env sh\nexit 0\n");
  await Promise.all(["docker", "hostname", "jq"].map((tool) => chmod(resolve(tools, tool), 0o755)));
  return { calls, path: `${tools}:/usr/bin:/bin` };
}

function agentEnvironment(tools: Readonly<{ calls: string; path: string }>, hostnameOutput: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DIM_DEVELOPMENT_GATEWAY_PORT: "12345",
    DIM_GIT_TOKEN: "test-token",
    DIM_GIT_USERNAME: "test-user",
    DIM_TEST_DOCKER_CALLS: tools.calls,
    DIM_TEST_HOSTNAME_OUTPUT: hostnameOutput,
    DIM_WORKSPACE_GID: "1000",
    DIM_WORKSPACE_UID: "1000",
    DOCKER_HOST: "unix:///tmp/docker.sock",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_AUTHOR_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test User",
    PATH: tools.path
  };
}

describe("rich example agent relay routing", () => {
  it.each(richExamples)("maps the secret alias to the outer parent address for %s", async (example) => {
    // Given
    const address = "172.19.0.7";
    const tools = await prepareTools(address);
    const agent = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim/agent-dind/agent.sh");

    // When
    const result = spawnSync("/usr/bin/sh", [agent, "setup"], {
      encoding: "utf8",
      env: agentEnvironment(tools, address)
    });

    // Then
    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(tools.calls, "utf8");
    expect(calls).toContain("--add-host secret:172.19.0.7");
    expect(calls).not.toContain("host-gateway");
  });

  it.each(richExamples)("rejects an ambiguous outer parent address for %s", async (example) => {
    // Given
    const addresses = "172.19.0.7 172.20.0.8";
    const tools = await prepareTools(addresses);
    const agent = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim/agent-dind/agent.sh");

    // When
    const result = spawnSync("/usr/bin/sh", [agent, "setup"], {
      encoding: "utf8",
      env: agentEnvironment(tools, addresses)
    });

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outer agent address is not one routable IPv4 address");
  });

  it.each(richExamples)("rejects a non-routable outer parent address for %s", async (example) => {
    // Given
    const address = "127.0.0.1";
    const tools = await prepareTools(address);
    const agent = resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim/agent-dind/agent.sh");

    // When
    const result = spawnSync("/usr/bin/sh", [agent, "setup"], {
      encoding: "utf8",
      env: agentEnvironment(tools, address)
    });

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outer agent address is not one routable IPv4 address");
  });
});
