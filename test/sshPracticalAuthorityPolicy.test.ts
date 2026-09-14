import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectAgent = resolve(workspaceRoot, "project/.dim/agent-dind/agent.sh");
const fullDevelopmentDim = resolve(
  workspaceRoot,
  "examples/projects/full-development-flow/repos/root/.dim"
);
const fullDevelopmentDockerfile = resolve(fullDevelopmentDim, "agent/Dockerfile");
const fullDevelopmentStartup = resolve(fullDevelopmentDim, "agent/start-sshd.sh");
const fullDevelopmentShell = resolve(fullDevelopmentDim, "agent/dim-agent-shell");
const fullDevelopmentCompose = resolve(fullDevelopmentDim, "docker-compose.yml");

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
    const startup = await readFile(resolve(workspaceRoot, "project/.dim/qemu-service-startup.mjs"), "utf8");
    const agent = await readFile(projectAgent, "utf8");

    expect(setup).toContain('install -d -m 0755 "$qemu_service_dir"');
    expect(service).toContain("await mkdir(serviceDirectory, { recursive: true, mode: 0o755 })");
    expect(startup).toContain("await chmod(config.socketPath, 0o666)");
    expect(`${service}\n${startup}`).not.toContain("chmod(socketPath, 0o600)");
    expect(service).not.toContain("mode: 0o777");
    expect(agent).toContain(
      "--mount type=bind,src=/run/dim/qemu-verification,dst=/run/dim/qemu-verification,readonly"
    );
  });
});

describe("full-development non-root SSH practical authority", () => {
  it("uses the fixed shell with a standalone server policy", async () => {
    const dockerfile = await readFile(fullDevelopmentDockerfile, "utf8");

    expect(dockerfile).toContain("COPY dim-agent-shell /usr/local/bin/dim-agent-shell");
    expect(dockerfile.match(/--shell \/usr\/local\/bin\/dim-agent-shell/g)).toHaveLength(3);
    expect(dockerfile).toContain("'PermitUserEnvironment no'");
    expect(dockerfile).toMatch(/>\s*\/etc\/ssh\/sshd_config$/m);
    expect(dockerfile).not.toMatch(/\bInclude\b|\bAcceptEnv\b|sshd_config\.d/);
  });

  it("loads server-owned ephemeral state through the fixed shell bridge", async () => {
    const shellBridge = await readFile(fullDevelopmentShell, "utf8");

    expect(shellBridge).toContain(". /run/dim-agent/environment");
    expect(shellBridge).toMatch(
      /case "\$#" in[\s\S]*0\) exec \/bin\/bash --login ;;[\s\S]*2\)[\s\S]*test "\$1" = -c \|\| exit 2[\s\S]*exec \/bin\/bash -c "\$2"[\s\S]*\*\) exit 2 ;;/
    );
    expect(shellBridge).not.toMatch(/^\s*(?:env|printenv)(?:\s|$)/m);
  });

  it("creates the session environment atomically under a root-owned runtime", async () => {
    const startup = await readFile(fullDevelopmentStartup, "utf8");

    expect(startup).toContain("runtime_dir=/run/dim-agent");
    expect(startup).toContain('environment_file="$runtime_dir/environment"');
    expect(startup).toContain('install -d -o root -g dim-agent -m 0750 "$runtime_dir"');
    expect(startup).toContain('install -o root -g dim-agent -m 0440 /dev/null "$environment_file"');
    expect(startup).toContain('environment_temp="$(mktemp "$runtime_dir/.environment.XXXXXX")"');
    expect(startup).toContain('chown root:dim-agent "$environment_temp"');
    expect(startup).toContain('chmod 0440 "$environment_temp"');
    expect(startup).toContain('mv -f "$environment_temp" "$environment_file"');
    expect(startup).not.toMatch(/environment_file=.*\/home\/dim-agent/);
  });

  it("grants workspace and private Docker access with ACLs rather than privilege", async () => {
    const dockerfile = await readFile(fullDevelopmentDockerfile, "utf8");
    const startup = await readFile(fullDevelopmentStartup, "utf8");
    const packages = dockerfile.slice(
      dockerfile.indexOf("apt-get install"),
      dockerfile.indexOf("rm -f /etc/ssh")
    );

    expect(packages).toMatch(/\bacl\b/);
    expect(startup).toContain("setfacl -R -m u:dim-agent:rwX /workspace");
    expect(startup).toContain("find /workspace -type d -exec setfacl -m d:u:dim-agent:rwX {} +");
    expect(startup).toContain("setfacl -m u:dim-agent:rw /run/dim-agent-dind/docker.sock");
    expect(startup).not.toMatch(/chown[^\n]*\/workspace/);
    expect(`${dockerfile}\n${startup}`).not.toMatch(
      /\bsudo\b|\bchmod\s+(?:u\+s|4\d{3}|[0-7]*[2367])\b/
    );
  });

  it("shares only the private Unix Docker socket and keeps runtime state ephemeral", async () => {
    const compose = await readFile(fullDevelopmentCompose, "utf8");
    const startup = await readFile(fullDevelopmentStartup, "utf8");
    const runtimeMounts =
      compose.match(/^\s+- [^:\n]+:\/run\/dim-agent-dind$/gm)?.map((mount) => mount.trim()) ?? [];

    expect(compose).toMatch(
      /^  agent:[\s\S]*?^    depends_on:\n      agent-dind:\n        condition: service_healthy/m
    );
    expect(compose).not.toMatch(/^  agent:\n(?:(?!^  \S+:)[\s\S])*?^    ports:/m);
    expect(
      compose.match(/DOCKER_HOST: "unix:\/\/\/run\/dim-agent-dind\/docker\.sock"/g) ?? []
    ).toHaveLength(2);
    expect(runtimeMounts).toHaveLength(2);
    expect(new Set(runtimeMounts).size).toBe(1);
    expect(startup).toContain("test -S /run/dim-agent-dind/docker.sock");
    expect(`${compose}\n${startup}`).not.toMatch(/tcp:\/\/|\/var\/run\/docker\.sock/);
    expect(compose).toContain("- agent-home:/home/dim-agent");
    expect(compose).not.toMatch(/-\s+[^:\n]+:\/run\/dim-agent(?:\s|$)/);
  });

  it("limits session state to Docker, bounded Git, and the constrained controller socket", async () => {
    const compose = await readFile(fullDevelopmentCompose, "utf8");
    const startup = await readFile(fullDevelopmentStartup, "utf8");
    const allowlist = startup
      .match(/allowed_environment=\(\n([\s\S]*?)\n\)/)?.[1]
      ?.trim()
      .split(/\s+/);

    expect(allowlist).toEqual([
      "PATH",
      "HOME",
      "DOCKER_HOST",
      "DIM_CONTROLLER_SOCKET",
      "DIM_GIT_USERNAME",
      "DIM_GIT_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_KEY_1",
      "GIT_CONFIG_VALUE_1",
      "GIT_CONFIG_KEY_2",
      "GIT_CONFIG_VALUE_2",
      "GIT_TERMINAL_PROMPT"
    ]);
    expect(compose).toContain('DIM_CONTROLLER_SOCKET: "/run/dim/controller-proxy/agent.sock"');
    for (const variable of [
      "DIM_GIT_USERNAME",
      "DIM_GIT_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL"
    ]) {
      expect(compose).toMatch(new RegExp(`^\\s+${variable}:`, "m"));
    }
    expect(compose).toContain('GIT_CONFIG_COUNT: "3"');
    expect(compose).toContain("GIT_CONFIG_KEY_0: credential.helper");
    expect(compose).toContain(
      'GIT_CONFIG_VALUE_0: "!f() { echo username=$$DIM_GIT_USERNAME; echo password=$$DIM_GIT_TOKEN; }; f"'
    );
    expect(compose).toContain("GIT_CONFIG_KEY_1: safe.directory");
    expect(compose).toContain("GIT_CONFIG_VALUE_1: /workspace");
    expect(compose).toContain("GIT_CONFIG_KEY_2: safe.directory");
    expect(compose).toContain("GIT_CONFIG_VALUE_2: /workspace/*");
    expect(compose).toContain('GIT_TERMINAL_PROMPT: "0"');
    expect(`${compose}\n${startup}`).not.toMatch(
      /DIM_CONTROLLER_TOKEN|DIM_EXTERNAL_URL_SOCKET|DIM_EXTERNAL_URL_CONTAINERS_JSON|DIM_QEMU_VERIFICATION_SOCKET/
    );
  });

  it("checks the actual SSH listener with bounded healthcheck settings", async () => {
    const compose = await readFile(fullDevelopmentCompose, "utf8");

    expect(compose).toMatch(
      /^  agent:\n(?:(?!^  \S+:)[\s\S])*?^    healthcheck:\n      test: \["CMD-SHELL", "nc -z 127\.0\.0\.1 22"\]\n      interval: 1s\n      timeout: 5s\n      retries: 60/m
    );
  });

  it("waits boundedly for the actual SSH listener before setup returns", async () => {
    const setup = await readFile(
      resolve(workspaceRoot, "examples/projects/full-development-flow/repos/root/.dim/setup.sh"),
      "utf8"
    );

    expect(setup).toContain("up --detach --build --force-recreate --wait --wait-timeout 60");
  });
});
