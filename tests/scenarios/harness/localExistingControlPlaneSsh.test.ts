/** Opt-in disposable sshd/container check: DIM_TEST_EXISTING_CP_SSH=1 pnpm --dir tests exec vitest run scenarios/harness/localExistingControlPlaneSsh.test.ts */
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { it, expect } from "vitest";
import { existingSshTransport } from "../../../scripts/local-control-plane/existing-ssh.ts";
import { createCommand, checked, type Command } from "../../../scripts/local-uninstall/command.ts";
import type { ExistingConnections } from "../../../scripts/local-control-plane/existing-connections.ts";

it.skipIf(process.env.DIM_TEST_EXISTING_CP_SSH !== "1")("authenticates the owned SSH master before using real forwarded services and rejects an occupied-port impostor", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-existing-ssh-")), name = `dim-existing-ssh-${randomUUID()}`;
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") }, real = createCommand(env);
  let managed: ChildProcess | undefined, created = false;
  const unit = join(env.XDG_CONFIG_HOME, "systemd/user/dim-existing-control-plane-tunnel.service");
  const socketDirectory = join(root, "runtime");
  const stopManaged = async () => {
    if (!managed) return;
    const child = managed; managed = undefined;
    const done = new Promise<void>((resolve) => child.once("close", () => resolve())); child.kill("SIGTERM"); await done;
  };
  const freePort = async () => {
    const server = createServer(); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test port");
    await new Promise<void>((done) => server.close(() => done())); return address.port;
  };
  try {
    const nativePort = await freePort(), executionPort = await freePort();
    await checked(real, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "login")]);
    await checked(real, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host")]);
    await writeFile(join(root, "sshd_config"), `Port 22\nHostKey /fixture/host\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthorizedKeysFile /root/.ssh/authorized_keys\nUsePAM no\nAllowTcpForwarding yes\n`);
    await writeFile(join(root, "services.mjs"), `// @ts-check\nimport { createServer } from "node:http";\nfor (const [port, service] of [[${nativePort}, "native"], [${executionPort}, "execution"]]) createServer((_q, r) => r.end(JSON.stringify({service}))).listen(port, "127.0.0.1");\n`);
    await checked(real, "docker", ["run", "--detach", "--name", name, "--publish", "127.0.0.1::22", "--mount", `type=bind,source=${root},target=/fixture,readonly`, "alpine:3.23", "sleep", "infinity"]); created = true;
    await checked(real, "docker", ["exec", name, "apk", "add", "--no-cache", "openssh-server", "nodejs"]);
    await checked(real, "docker", ["exec", name, "sh", "-c", "mkdir -p /root/.ssh /run/sshd; chmod 700 /root/.ssh; cp /fixture/login.pub /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; passwd -d root"]);
    await checked(real, "docker", ["exec", "--detach", name, "/usr/sbin/sshd", "-D", "-f", "/fixture/sshd_config"]);
    await checked(real, "docker", ["exec", "--detach", name, "node", "/fixture/services.mjs"]);
    const published = (await checked(real, "docker", ["port", name, "22/tcp"])).trim();
    const sshPort = published.split(":").at(-1)!;
    await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${sshPort} ${await readFile(join(root, "host.pub"), "utf8")}`, { mode: 0o600 });
    const configurationFile = join(root, "ssh_config");
    await writeFile(configurationFile, `Host fixture-cp\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User root\n  IdentityFile ${root}/login\n  IdentitiesOnly yes\n  UserKnownHostsFile ${root}/known_hosts\n  LogLevel ERROR\n`, { mode: 0o600 });
    const run: Command = async (file, args) => {
      if (file !== "systemctl") return real(file, args);
      if (args.includes("is-active")) return { status: managed ? 0 : 1, stdout: "", stderr: "" };
      if (args.includes("restart")) {
        await stopManaged();
        // Emulate RuntimeDirectoryPreserve=no: systemd recreates private runtime
        // state on every service start, including after reboot or SIGKILL.
        await rm(socketDirectory, { recursive: true, force: true });
        await mkdir(socketDirectory, { mode: 0o700 });
        const text = await readFile(unit, "utf8"), line = text.split("\n").find((line) => line.startsWith("ExecStart="))!;
        const args = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([token]) => JSON.parse(token) as string);
        managed = spawn("/usr/bin/ssh", args, { env, stdio: "ignore" });
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const bundle: ExistingConnections = { files: {}, hostId: "fixture-host", generationId: "a".repeat(64), identities: [], nativeEndpoint: `http://127.0.0.1:${nativePort}`, executionEndpoint: `http://127.0.0.1:${executionPort}` };
    const transport = existingSshTransport(env, run, { configurationFile, runtimeDirectory: socketDirectory });
    await transport.temporary("fixture-cp", bundle, async () => {
      expect(await (await fetch(bundle.nativeEndpoint)).json()).toEqual({ service: "native" });
      expect(await (await fetch(bundle.executionEndpoint)).json()).toEqual({ service: "execution" });
    });
    // An unrelated service already listening locally must never receive role credentials.
    const impostor = createServer((_request, response) => response.end("impostor"));
    await new Promise<void>((done) => impostor.listen(nativePort, "127.0.0.1", done));
    let credentialAction = false;
    try {
      await expect(transport.temporary("fixture-cp", bundle, async () => { credentialAction = true; })).rejects.toThrow("SSH forwarding exited");
      expect(credentialAction).toBe(false);
    } finally { await new Promise<void>((done) => impostor.close(() => done())); }
    await transport.persist("fixture-cp", bundle);
    expect(await (await fetch(bundle.nativeEndpoint)).json()).toEqual({ service: "native" });
    // A reboot discards /run/user state; restarting the owned unit recreates it.
    await stopManaged();
    await rm(socketDirectory, { recursive: true, force: true });
    await transport.persist("fixture-cp", bundle);
    expect(await (await fetch(bundle.executionEndpoint)).json()).toEqual({ service: "execution" });
    // A stale socket left by SIGKILL must not prevent the service from restarting.
    const killed = managed!;
    const killedDone = new Promise<void>((done) => killed.once("close", () => done()));
    killed.kill("SIGKILL"); await killedDone; managed = undefined;
    await transport.persist("fixture-cp", bundle);
    expect(await (await fetch(bundle.nativeEndpoint)).json()).toEqual({ service: "native" });
    // Repeated install preflight reuses this exact owned running master.
    await transport.temporary("fixture-cp", bundle, async () => {
      expect(await (await fetch(bundle.executionEndpoint)).json()).toEqual({ service: "execution" });
    });
  } finally {
    await stopManaged();
    if (created) await checked(real, "docker", ["rm", "--force", name]);
    await rm(socketDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
