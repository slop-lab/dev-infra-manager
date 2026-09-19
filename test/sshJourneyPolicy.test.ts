import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const verificationRoot = resolve(import.meta.dirname, "..");
const statefulSmoke = resolve(verificationRoot, "scripts/stateful-development-flow-smoke.bash");
const selfSmoke = resolve(verificationRoot, "scripts/container-self-project-smoke.bash");
const selfSshFixture = resolve(verificationRoot, "scripts/lib/container-self-project-ssh-fixture.bash");
const selfSshChecks = resolve(verificationRoot, "scripts/lib/container-self-project-ssh-checks.bash");

function section(source: string, start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function expectSshClientPolicy(source: string): void {
  expect(source.match(/^    User dim-agent$/gm)).toHaveLength(2);
  expect(source).toContain("RequestTTY no");
  expect(source).toContain("StrictHostKeyChecking yes");
  expect(source).toContain("ProxyCommand");
  expect(source).toContain('-o User=root');
  expect(source).toContain("PasswordAuthentication=yes");
  expect(source).toContain('ssh -F "$wrong_ssh_config"');
  expect(source).toContain('test -z "$outer_ssh_port"');
  expect(source).toContain('test -z "$nested_ssh_port"');
  expect(source).toContain("-o SetEnv=DOCKER_HOST=unix:///tmp/client-controlled.sock");
  expect(source).toContain("-o SendEnv=DIM_GIT_TOKEN");
}

function expectPracticalAuthority(journey: string, dockerHost: string): void {
  expect(journey).toContain("id -u");
  expect(journey).toContain("dim-agent");
  expect(journey).toContain("/home/dim-agent");
  expect(journey).toContain("/workspace/");
  for (const operation of ["touch", "printf", "cat", "rm"]) expect(journey).toContain(operation);
  expect(journey).toContain(`test "$DOCKER_HOST" = ${dockerHost}`);
  expect(journey).toContain("docker info");
  expect(journey).toContain("grep -q rootless");
  expect(journey).toContain("docker run --rm");
  expect(journey).toContain("git config --get credential.helper");
  expect(journey).toContain("git config --get-all safe.directory");
  expect(journey).toContain("git ls-remote origin HEAD");
  expect(journey).not.toContain("git config --list");
  expect(journey).toContain('test -S "$DIM_EXTERNAL_URL_SOCKET"');
  expect(journey).toMatch(/curl[^\n]*--unix-socket "\$DIM_EXTERNAL_URL_SOCKET"/);
  expect(journey).toContain('test -S "$DIM_QEMU_VERIFICATION_SOCKET"');
  expect(journey).toContain("qemu-client.mjs probe");
  expect(journey).toContain("qemu-client.mjs status");
}

describe("capable-host SSH journeys", () => {
  it.each([
    ["full-development", statefulSmoke, "dim_stateful_initialize_work_tree"],
    ["canonical self-Project", selfSmoke, "exec 9>"]
  ])("reports unavailable before %s state allocation", async (_name, path, firstMutation) => {
    const smoke = await readFile(path, "utf8");
    const gate = smoke.indexOf("for required_command in ssh ssh-keygen");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(smoke.indexOf(firstMutation));
    expect(smoke.slice(gate, smoke.indexOf(firstMutation))).toMatch(/unavailable:[^\n]*>&2[\s\S]*exit 2/);
  });

  it("proves full-development SSH authority and denials through the fixed proxy", async () => {
    const smoke = await readFile(statefulSmoke, "utf8");
    const journey = section(smoke, "connect through key-only OpenSSH", "preserve work across dirty rejection");
    expectSshClientPolicy(smoke);
    expectPracticalAuthority(journey, "unix:///run/dim-agent-dind/docker.sock");
    expect(journey).toContain("test -S /run/dim-agent-dind/docker.sock");
    expect(journey).not.toContain("tcp://agent-dind:2375");
    expect(journey).not.toContain("test ! -e /run/docker.sock");
    expect(journey).toContain("GIT_TERMINAL_PROMPT=0 git ls-remote origin HEAD");
    expect(smoke).toContain('project_task_uid="$(dim workspace run');
    expect(smoke).toContain('test "$project_task_uid" -ne 0');
  });

  it("proves canonical self-Project SSH authority and denials through the nested rootless agent", async () => {
    const smoke = (await Promise.all(
      [selfSmoke, selfSshFixture, selfSshChecks].map(async (path) => readFile(path, "utf8"))
    )).join("\n");
    const journey = section(smoke, 'verification_stage="authenticated non-root SSH authority"', 'verification_stage="agent identity"');
    expectSshClientPolicy(smoke);
    expectPracticalAuthority(journey, "unix:///run/docker.sock");
    expect(journey).toContain('test "$GIT_TERMINAL_PROMPT" = 0');
    expect(journey).toContain("test -S /run/docker.sock");
    expect(journey).toContain("test ! -e /var/run/docker.sock");
  });

  it("keeps tokens out of SSH verification output while proving override denial", async () => {
    for (const path of [statefulSmoke, selfSmoke]) {
      const smoke = path === selfSmoke
        ? (await Promise.all(
          [selfSmoke, selfSshFixture, selfSshChecks].map(async (source) => readFile(source, "utf8"))
        )).join("\n")
        : await readFile(path, "utf8");
      expect(smoke).not.toContain("printenv");
      expect(smoke).not.toContain("env | sort");
      expect(smoke).toContain('test -n "$DIM_GIT_TOKEN"');
      expect(smoke).toContain('test "$DIM_GIT_TOKEN" != client-controlled-token');
    }
  });
});
