import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectAgent = resolve(workspaceRoot, ".dim/agent-dind/agent.sh");
const projectCompose = resolve(workspaceRoot, ".dim/docker-compose.yml");
const fullDevelopmentDim = resolve(
  workspaceRoot,
  "examples/projects/full-development-flow/repos/root/.dim"
);
const fullDevelopmentDockerfile = resolve(fullDevelopmentDim, "agent/Dockerfile");
const fullDevelopmentStartup = resolve(fullDevelopmentDim, "agent/start-sshd.sh");
const fullDevelopmentShell = resolve(fullDevelopmentDim, "agent/dim-agent-shell");
const fullDevelopmentCompose = resolve(fullDevelopmentDim, "docker-compose.yml");
const fullDevelopmentAgentLauncher = resolve(fullDevelopmentDim, "agent-dind/agent.sh");
const fullDevelopmentDindEntrypoint = resolve(fullDevelopmentDim, "agent-dind/entrypoint.sh");

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
    const setup = await readFile(resolve(workspaceRoot, ".dim/setup.sh"), "utf8");
    const service = await readFile(resolve(workspaceRoot, ".dim/qemu-service.mjs"), "utf8");
    const startup = await readFile(resolve(workspaceRoot, ".dim/qemu-service-startup.mjs"), "utf8");
    const filesystem = await readFile(resolve(workspaceRoot, ".dim/qemu-service-filesystem.mjs"), "utf8");
    const compose = await readFile(projectCompose, "utf8");
    const agent = await readFile(projectAgent, "utf8");

    expect(setup).toContain('sudo -n /usr/bin/install -d -o root -g root -m 0755 "$qemu_service_dir"');
    expect(filesystem).toContain("constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW");
    expect(filesystem).toContain("descriptorStat.uid !== 0n || descriptorStat.gid !== 0n");
    expect(filesystem).toContain("(descriptorStat.mode & 0o7777n) !== 0o755n");
    expect(startup).toContain("await chmod(socketLeasePath(config.socketPath), 0o666)");
    expect(`${service}\n${startup}`).not.toContain("chmod(socketPath, 0o600)");
    expect(service).not.toContain("mode: 0o777");
    expect(agent).toContain(
      "--mount type=bind,src=/run/dim/qemu-verification,dst=/run/dim/qemu-verification,readonly"
    );
    expect(compose).toContain("/tmp/dim-qemu-verification:/run/dim/qemu-verification:ro");
  });

  it("serializes setup-producing and discard lifecycle entry points", async () => {
    const sources = await Promise.all(["workspaceCreation.ts", "workspaceSetup.ts", "workspaceDiscard.ts"]
      .map((name) => readFile(resolve(workspaceRoot, "core/packages/core/src", name), "utf8")));
    for (const source of sources) expect(source).toContain("acquireWorkspaceSetupLock");
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

  it("keeps SSH authority bounded while allowing container-local sudo", async () => {
    const dockerfile = await readFile(fullDevelopmentDockerfile, "utf8");
    const startup = await readFile(fullDevelopmentStartup, "utf8");
    const packages = dockerfile.slice(
      dockerfile.indexOf("apt-get install"),
      dockerfile.indexOf("rm -f /etc/ssh")
    );

    expect(packages).toMatch(/\bacl\b/);
    expect(packages).toMatch(/\bsudo\b/);
    expect(dockerfile.match(/dim-agent ALL=\(root\) NOPASSWD: ALL/g)).toHaveLength(1);
    expect(dockerfile).toContain("visudo --check --file=/etc/sudoers.d/dim-agent");
    expect(startup).toContain("setfacl -R -m u:dim-agent:rwX /workspace");
    expect(startup).toContain("find /workspace -type d -exec setfacl -m d:u:dim-agent:rwX {} +");
    expect(startup).toContain("setfacl -m u:dim-agent:rw /run/dim-agent-dind/docker.sock");
    expect(startup).not.toMatch(/chown[^\n]*\/workspace/);
    expect(`${dockerfile}\n${startup}`).not.toMatch(/\bchmod\s+(?:u\+s|4\d{3}|[0-7]*[2367])\b/);
  });

  it("shares only the private Unix Docker socket and keeps runtime state ephemeral", async () => {
    const compose = await readFile(fullDevelopmentCompose, "utf8");
    const startup = await readFile(fullDevelopmentStartup, "utf8");
    const launcher = await readFile(fullDevelopmentAgentLauncher, "utf8");

    expect(launcher).toContain("--env DOCKER_HOST=unix:///run/dim-agent-dind/docker.sock");
    expect(launcher).toContain('dst=/run/dim-agent-dind/docker.sock"');
    expect(startup).toContain("test -S /run/dim-agent-dind/docker.sock");
    expect(`${compose}\n${launcher}\n${startup}`).not.toMatch(/tcp:\/\/|\/var\/run\/docker\.sock/);
    expect(compose).toContain("- agent-home:/mnt/agent-home");
    expect(launcher).toContain("src=/mnt/agent-home,dst=/home/dim-agent");
  });

  it("starts DinD explicitly with only the private Unix listener", async () => {
    const compose = await readFile(fullDevelopmentCompose, "utf8");
    const entrypoint = await readFile(fullDevelopmentDindEntrypoint, "utf8");

    expect(entrypoint).toContain('DOCKER_HOST="unix://$runtime_dir/docker.sock"');
    expect(entrypoint).toContain('dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"');
    expect(`${compose}\n${entrypoint}`).not.toMatch(/--host=tcp:|2375|2376/);
  });

  it("limits session state to Docker, bounded Git, and the constrained controller socket", async () => {
    const compose = await readFile(fullDevelopmentCompose, "utf8");
    const startup = await readFile(fullDevelopmentStartup, "utf8");
    const launcher = await readFile(fullDevelopmentAgentLauncher, "utf8");
    const allowlist = startup
      .match(/allowed_environment=\(\n([\s\S]*?)\n\)/)?.[1]
      ?.trim()
      .split(/\s+/);

    expect(allowlist).toEqual([
      "PATH",
      "HOME",
      "DOCKER_HOST",
      "TMPDIR",
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
    expect(launcher).toContain("--env DIM_CONTROLLER_SOCKET=/run/dim/controller-proxy/agent.sock");
    for (const variable of [
      "DIM_GIT_USERNAME",
      "DIM_GIT_TOKEN",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL"
    ]) {
      expect(launcher).toContain(`--env \"${variable}=$${variable}\"`);
    }
    expect(launcher).toContain("--env GIT_CONFIG_COUNT=3");
    expect(launcher).toContain("--env GIT_CONFIG_KEY_0=credential.helper");
    expect(launcher).toContain("--env GIT_CONFIG_KEY_1=safe.directory");
    expect(launcher).toContain("--env GIT_CONFIG_VALUE_1=/workspace");
    expect(launcher).toContain("--env GIT_CONFIG_KEY_2=safe.directory");
    expect(launcher).toContain("--env 'GIT_CONFIG_VALUE_2=/workspace/*'");
    expect(launcher).toContain("--env GIT_TERMINAL_PROMPT=0");
    expect(`${compose}\n${launcher}\n${startup}`).not.toMatch(
      /DIM_CONTROLLER_TOKEN|DIM_QEMU_VERIFICATION_SOCKET/
    );
  });

  it("checks the actual SSH listener with bounded healthcheck settings", async () => {
    const launcher = await readFile(fullDevelopmentAgentLauncher, "utf8");

    expect(launcher).toContain("for attempt in $(seq 1 60)");
    expect(launcher).toContain('docker exec "$agent_name" nc -z 127.0.0.1 22');
    expect(launcher).toContain('test "$attempt" -lt 60');
  });

  it("waits boundedly for the actual SSH listener before setup returns", async () => {
    const setup = await readFile(
      resolve(workspaceRoot, "examples/projects/full-development-flow/repos/root/.dim/setup.sh"),
      "utf8"
    );

    expect(setup).toContain("up --detach --force-recreate --wait --wait-timeout 60 agent-dind");
    expect(setup).toContain("agent-dind dim-agent-dind setup");
  });
});
