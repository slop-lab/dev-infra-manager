import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("root Docker context policy", () => {
  it("allows only the agent runtime scripts through the ignored agent directory", async () => {
    const rules = (await readFile(resolve(workspaceRoot, ".dockerignore"), "utf8"))
      .split("\n")
      .map((rule) => rule.trim())
      .filter((rule) => rule.length > 0);

    const agentRules = rules.filter((rule) => rule.includes("agent"));

    expect(agentRules).toEqual([
      "!agent/",
      "agent/*",
      "!agent/dim-agent-shell",
      "!agent/start-sshd.sh"
    ]);
    expect(rules.indexOf("!agent/")).toBeLessThan(rules.indexOf("agent/*"));
    expect(rules.indexOf("agent/*")).toBeLessThan(rules.indexOf("!agent/dim-agent-shell"));
    expect(rules.indexOf("!agent/dim-agent-shell")).toBeLessThan(rules.indexOf("!agent/start-sshd.sh"));
    expect(agentRules).not.toContain("!agent/**");
    expect(agentRules).not.toContain("!agent/*");
    expect(await readFile(resolve(workspaceRoot, "agent/start-sshd.sh"), "utf8")).toContain("#!/usr/bin/env bash");
    expect(await readFile(resolve(workspaceRoot, "agent/Dockerfile"), "utf8"))
      .toContain("COPY agent/start-sshd.sh /usr/local/bin/start-sshd");
  });

  it("configures key-only SSH for a non-root dim-agent account", async () => {
    const dockerfile = await readFile(resolve(workspaceRoot, "agent/Dockerfile"), "utf8");

    const createsOrUpdatesDimAgent = /\b(?:useradd|usermod)\b[^\n]*\bdim-agent\b/;

    expect(dockerfile).toMatch(/^ARG DIM_AGENT_UID=[1-9]\d*$/m);
    expect(dockerfile).toContain('test "$DIM_AGENT_UID" -ne 0');
    expect(dockerfile).toMatch(createsOrUpdatesDimAgent);
    expect(dockerfile).toContain("'PermitRootLogin no'");
    expect(dockerfile).toContain("'PubkeyAuthentication yes'");
    expect(dockerfile).toContain("'AuthenticationMethods publickey'");
    expect(dockerfile).toContain("'PasswordAuthentication no'");
    expect(dockerfile).toContain("'PermitEmptyPasswords no'");
    expect(dockerfile).toContain("'KbdInteractiveAuthentication no'");
    expect(dockerfile).toContain("'AuthorizedKeysFile /home/dim-agent/.ssh/authorized_keys'");
    expect(dockerfile).toContain("'AllowUsers dim-agent'");
    expect(dockerfile).toMatch(/(?:passwd -d|usermod --unlock) dim-agent/);
  });

  it("installs Python for source checks that exercise the shipped Python services", async () => {
    const dockerfile = await readFile(resolve(workspaceRoot, "agent/Dockerfile"), "utf8");
    const packages = dockerfile.slice(dockerfile.indexOf("apt-get install"), dockerfile.indexOf("rm -f /etc/ssh"));

    expect(packages).toMatch(/\bpython3\b/);
  });

  it("replaces the ambient sshd configuration with a closed server policy", async () => {
    const dockerfile = await readFile(resolve(workspaceRoot, "agent/Dockerfile"), "utf8");

    expect(dockerfile).toContain("'PermitUserEnvironment no'");
    expect(dockerfile).toMatch(/>\s*\/etc\/ssh\/sshd_config$/m);
    expect(dockerfile).not.toMatch(/\bInclude\b|\bAcceptEnv\b|sshd_config\.d/);
  });

  it("installs fail-closed ACL authority for the non-root SSH account", async () => {
    const dockerfile = await readFile(resolve(workspaceRoot, "agent/Dockerfile"), "utf8");
    const startup = await readFile(resolve(workspaceRoot, "agent/start-sshd.sh"), "utf8");
    const packages = dockerfile.slice(dockerfile.indexOf("apt-get install"), dockerfile.indexOf("rm -f /etc/ssh"));

    expect(packages).toMatch(/\bacl\b/);
    expect(startup).toContain("test -d /workspace");
    expect(startup).toContain("test -S /run/docker.sock");
    expect(startup).toContain("setfacl -R -m u:dim-agent:rwX /workspace");
    expect(startup).toContain("find /workspace -type d -exec setfacl -m d:u:dim-agent:rwX {} +");
    expect(startup).toContain("setfacl -m u:dim-agent:rw /run/docker.sock");
    expect(startup).not.toMatch(/chown[^\n]*\/workspace/);
  });

  it("keeps session state root-owned and probes practical authority as dim-agent", async () => {
    const startup = await readFile(resolve(workspaceRoot, "agent/start-sshd.sh"), "utf8");

    expect(startup).toContain('install -d -o root -g dim-agent -m 0750 "$runtime_dir"');
    expect(startup).toContain('install -o root -g dim-agent -m 0440 /dev/null "$environment_file"');
    expect(startup).toMatch(/runuser -u dim-agent -- (?:touch|sh -c .*touch).*\/workspace\//);
    expect(startup).toMatch(/runuser -u dim-agent -- (?:rm|sh -c .*rm).*\/workspace\//);
    expect(startup).toMatch(/runuser -u dim-agent -- (?:touch|sh -c .*touch).*\/home\/dim-agent\//);
    expect(startup).toMatch(/runuser -u dim-agent -- (?:rm|sh -c .*rm).*\/home\/dim-agent\//);
    expect(startup).toContain('runuser -u dim-agent -- test -r "$environment_file"');
    expect(startup).toContain(
      "runuser -u dim-agent -- env DOCKER_HOST=unix:///run/docker.sock docker info >/dev/null"
    );
    expect(startup).not.toContain("/var/run/docker.sock");
  });

  it("uses a fixed shell to load only server-owned ephemeral session state", async () => {
    const dockerfile = await readFile(resolve(workspaceRoot, "agent/Dockerfile"), "utf8");
    const startup = await readFile(resolve(workspaceRoot, "agent/start-sshd.sh"), "utf8");

    expect(dockerfile).toContain("COPY agent/dim-agent-shell /usr/local/bin/dim-agent-shell");
    expect(dockerfile.match(/--shell \/usr\/local\/bin\/dim-agent-shell/g)).toHaveLength(3);
    expect(dockerfile).not.toContain("AcceptEnv");
    expect(dockerfile).toContain("'PermitUserEnvironment no'");
    expect(startup).toContain("runtime_dir=/run/dim-agent");
    expect(startup).toContain('environment_file="$runtime_dir/environment"');

    const shellBridge = await readFile(resolve(workspaceRoot, "agent/dim-agent-shell"), "utf8");
    expect(shellBridge).toContain(". /run/dim-agent/environment");
    expect(shellBridge).toMatch(/case "\$#" in[\s\S]*0\) exec \/bin\/bash --login ;;[\s\S]*2\)[\s\S]*test "\$1" = -c \|\| exit 2[\s\S]*exec \/bin\/bash -c "\$2"[\s\S]*\*\) exit 2 ;;/);
    expect(shellBridge).not.toMatch(/^\s*(?:env|printenv)(?:\s|$)/m);
  });

  it("does not add privilege or secret-bearing artifacts to the agent image", async () => {
    const dockerfile = await readFile(resolve(workspaceRoot, "agent/Dockerfile"), "utf8");

    expect(dockerfile).not.toMatch(/\bsudo\b|\bchmod\s+(?:u\+s|4\d{3})\b/);
    expect(dockerfile).not.toMatch(/^(?:COPY|ADD)\s+[^\n]*(?:authorized_keys|id_(?:rsa|ed25519)|\/home)/m);
    expect(dockerfile).not.toContain("EXPOSE 22");
    expect(dockerfile).not.toContain("/var/run/docker.sock");
  });
});
