import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import { runCommand } from "../scenarios/web-lifecycle/process.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function realSshFixture(parent: string, environment: Readonly<Record<string, string>>) {
  const root = path.join(parent, "real-ssh"); await mkdir(root, { mode: 0o700 });
  const clientKey = path.join(root, "client"), hostKey = path.join(root, "host");
  for (const key of [clientKey, hostKey]) await runCommand("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  await cp(`${clientKey}.pub`, path.join(root, "authorized_keys"));
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("missing test SSH port");
  const port = address.port; await new Promise<void>((resolve) => listener.close(() => resolve()));
  const remote = path.join(root, "remote-session");
  const variables = Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error("invalid fixture environment key");
    return `${name}=${quote(value)}`;
  }).join(" ");
  await writeFile(remote, `#!/bin/sh\nexport ${variables}\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
  const config = path.join(root, "sshd.conf");
  await writeFile(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${userInfo().username}\nForceCommand ${remote}\nLogLevel VERBOSE\n`);
  const server = spawn("timeout", ["--kill-after=2s", "10800s", "/usr/sbin/sshd", "-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  const close = async () => { if (server.exitCode === null && server.signalCode === null) { const closed = once(server, "close"); server.kill("SIGTERM"); await closed; } };
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`test SSH readiness failed: ${diagnostics}`)), 5000);
      server.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); if (diagnostics.includes("Server listening")) { clearTimeout(deadline); resolve(); } });
      server.once("error", (error) => { clearTimeout(deadline); reject(error); });
      server.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`test sshd exited ${code}: ${diagnostics}`)); });
    });
    const knownHosts = path.join(root, "known_hosts"); await writeFile(knownHosts, `[127.0.0.1]:${port} ${(await readFile(`${hostKey}.pub`, "utf8")).trim()}\n`);
    const sshConfig = path.join(root, "ssh.conf");
    await writeFile(sshConfig, `Host fixture-host\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${clientKey}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${knownHosts}\n`);
    const bin = path.join(root, "bin"); await mkdir(bin);
    await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(sshConfig)} "$@"\n`, { mode: 0o700 });
    return { bin, target: "fixture-host", close, diagnostics: () => diagnostics };
  } catch (error) { await close(); throw error; }
}
