import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectAgent = resolve(workspaceRoot, "project/.dim/agent-dind/agent.sh");

describe("canonical non-root SSH practical authority", () => {
  it("passes the bounded Git identity, credential, safe-directory, and no-prompt configuration", async () => {
    const agent = await readFile(projectAgent, "utf8");

    expect(agent).toContain("--env GIT_CONFIG_COUNT=3");
    expect(agent).toContain("--env GIT_CONFIG_KEY_0=credential.helper");
    expect(agent).toContain("--env GIT_CONFIG_KEY_1=safe.directory");
    expect(agent).toContain("--env GIT_CONFIG_VALUE_1=/workspace");
    expect(agent).toContain("--env GIT_CONFIG_KEY_2=safe.directory");
    expect(agent).toContain("--env 'GIT_CONFIG_VALUE_2=/workspace/*'");
    expect(agent).toContain("--env GIT_TERMINAL_PROMPT=0");
    expect(agent).not.toContain("--env GIT_CONFIG_VALUE_1=*");
  });

  it("passes exactly the runtime bridge allowlist needed by agent sessions", async () => {
    const agent = await readFile(projectAgent, "utf8");

    for (const variable of [
      "DOCKER_HOST",
      "DIM_GIT_USERNAME",
      "DIM_GIT_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "DIM_EXTERNAL_URL_SOCKET",
      "DIM_EXTERNAL_URL_CONTAINERS_JSON",
      "DIM_QEMU_VERIFICATION_SOCKET"
    ]) {
      expect(agent).toMatch(new RegExp(`--env ["']?${variable}(?:=|["'])`));
    }
  });

  it("keeps Docker authority private and does not replace ACLs with ownership or setuid", async () => {
    const agent = await readFile(projectAgent, "utf8");

    expect(agent).toContain('--mount "type=bind,src=$docker_socket,dst=/run/docker.sock"');
    expect(agent).not.toContain("/var/run/docker.sock");
    expect(agent).not.toMatch(/chown[^\n]*\/workspace/);
    expect(agent).not.toMatch(/\bsudo\b|\bchmod\s+(?:u\+s|4\d{3})\b/);
  });

  it("creates the QEMU socket for constrained clients inside a dedicated directory", async () => {
    const setup = await readFile(resolve(workspaceRoot, "project/.dim/setup.sh"), "utf8");
    const service = await readFile(resolve(workspaceRoot, "project/.dim/qemu-service.mjs"), "utf8");
    const agent = await readFile(projectAgent, "utf8");

    expect(setup).toContain('install -d -m 0755 "$qemu_service_dir"');
    expect(service).toContain("await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o755 })");
    expect(service).toContain("await chmod(socketPath, 0o666)");
    expect(service).not.toContain("chmod(socketPath, 0o600)");
    expect(service).not.toContain("mode: 0o777");
    expect(agent).toContain(
      "--mount type=bind,src=/run/dim/qemu-verification,dst=/run/dim/qemu-verification,readonly"
    );
  });
});
