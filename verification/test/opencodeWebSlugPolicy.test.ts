import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const setupFiles = [
  ".dim/setup.sh",
  "examples/projects/full-development-flow/repos/root/.dim/setup.sh",
  "examples/projects/multi-repository/repos/root/.dim/setup.sh",
  "examples/projects/single-repository/repos/app/.dim/setup.sh"
] as const;
const agentFiles = [
  ".dim/agent-dind/agent.sh",
  "examples/projects/full-development-flow/repos/root/.dim/agent-dind/agent.sh",
  "examples/projects/multi-repository/repos/root/.dim/agent-dind/agent.sh",
  "examples/projects/single-repository/repos/app/.dim/docker-compose.yml"
] as const;

describe.each(setupFiles)("OpenCode service slug policy in %s", (setupFile) => {
  it("binds the reviewed service to the workspace-scoped opencode slug", async () => {
    // Given: reviewed Project lifecycle setup for an OpenCode-capable workspace.
    const source = await readFile(resolve(workspaceRoot, setupFile), "utf8");

    // When: the development URL proxy binding is inspected.
    const serviceBindings = source.match(/--bind-service-subdomain/g) ?? [];

    // Then: one exact mapping derives the authority from the trusted workspace name.
    expect(serviceBindings).toHaveLength(1);
    expect(source).toContain("${DIM_WORKSPACE_NAME:?}");
    expect(source).toContain("--opencode");
    expect(source).toContain('"opencode-web=$opencode_workspace_slug"');
    expect(source).toContain("--listen /tmp/dim-development-url/controller.sock");
    expect(source).toContain("--listen /tmp/dim-development-url/opencode.sock");
  });
});

describe.each(agentFiles)("OpenCode service socket policy in %s", (agentFile) => {
  it("mounts the dedicated reviewed socket alongside the generic socket", async () => {
    // Given: an agent configuration with the shared development URL directory.
    const source = await readFile(resolve(workspaceRoot, agentFile), "utf8");

    // When: the launcher and generic helper socket variables are inspected.
    // Then: each purpose has a distinct socket within the same read-only mount.
    expect(source).toContain("DIM_DEVELOPMENT_URL_SOCKET");
    expect(source).toContain("/run/dim/development-url/controller.sock");
    expect(source).toContain("OPENCODE_WEB_URL_SOCKET");
    expect(source).toContain("/run/dim/development-url/opencode.sock");
  });
});
