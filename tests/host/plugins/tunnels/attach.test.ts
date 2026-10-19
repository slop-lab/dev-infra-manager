import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { type WorkspaceService } from "@slop-lab/dim-host-core/workspace";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
import { runTunnels } from "../../../../packages/host/plugins/tunnels/src/index.js";
import { TunnelStore } from "../../../../packages/host/plugins/tunnels/src/store.js";
import { serveTunnels } from "../../../../packages/host/plugins/tunnels/src/server.js";

const execute = promisify(execFile);
const client = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));
it("host attachment installs private UUID-fenced guest payload and independent restartable service", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-tunnel-attach-"));
  const record = workspaceRecord("dev"), controller = new AbortController();
  const env = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}` };
  const run = (...args: string[]) => execute(process.execPath, [client, ...args], { env });
  const target = createServer({ allowHalfOpen: true }, (socket) => { socket.on("error", () => {}); socket.pipe(socket); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address(); if (!targetAddress || typeof targetAddress === "string") throw new Error("no target");
  const reservation = createServer(); await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const local = reservation.address(); if (!local || typeof local === "string") throw new Error("no local port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const store = new TunnelStore(path.join(home, "operator.json"));
  let relay: Awaited<ReturnType<typeof serveTunnels>> | undefined;
  const service: Pick<WorkspaceService, "show" | "exec"> = {
    async show() { return { ...record, runtimeStatus: "running" }; },
    async exec(name, command, options) {
      expect(name).toBe(record.name); expect(options?.workspaceId).toBe(record.id);
      const child = spawn(command[0] ?? "", command.slice(1), { env, stdio: ["pipe", "ignore", "pipe"] });
      options?.stdin?.pipe(child.stdin);
      const errors: Buffer[] = []; child.stderr.on("data", (data: Buffer) => errors.push(data));
      return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(0) : reject(new Error(Buffer.concat(errors).toString()))); });
    }
  };
  try {
    await mkdir(path.join(home, "bin"));
    await writeFile(path.join(home, "bin/dim-workspace"), `#!/bin/sh\nexec '${process.execPath}' '${client}' "$@"\n`); await chmod(path.join(home, "bin/dim-workspace"), 0o700);
    await store.initialize("operator"); await store.update((config) => { config.routes.echo = { protocol: "tcp", host: "127.0.0.1", port: targetAddress.port }; });
    relay = await serveTunnels(store, { async current(grant) { return grant.workspaceId === record.id; } }, { relayHost: "127.0.0.1", relayPort: 0, operatorPort: 0 });
    await run("session", "register", "--", "coding-agent", "resume");
    await runTunnels(["tunnel", "attach", record.name, "--config", store.file, "--route", "echo", "--endpoint", `127.0.0.1:${relay.relayPort}`, "--local-port", String(local.port)], { signal: controller.signal, service });
    const bytes = Buffer.from([0, 255, 128, 10]);
    const request = () => new Promise<Buffer>((resolve, reject) => { const socket = connect(local.port, "127.0.0.1"); const chunks: Buffer[] = []; socket.on("error", reject); socket.on("data", (chunk: Buffer) => chunks.push(chunk)); socket.once("end", () => resolve(Buffer.concat(chunks))); socket.once("connect", () => socket.end(bytes)); });
    await expect.poll(request).toEqual(bytes);
    await run("service", "remove", "tunnels");
    // Registration is durable after re-register and independent resume from a fresh process.
    await run("service", "register", "--name", "tunnels", "--", process.execPath, path.join(home, ".local/share/dim-tunnels/guest.mjs"), path.join(home, ".config/dim/tunnels.json"));
    await run("service", "resume"); await expect.poll(request).toEqual(bytes);
    expect(JSON.parse(await readFile(path.join(home, ".local/state/dim/session.json"), "utf8")).argv).toEqual(["coding-agent", "resume"]);
    expect(Object.values((await store.read()).grants)[0]?.workspaceId).toBe(record.id);
  } finally { await run("service", "remove", "tunnels").catch(() => {}); await relay?.close(); await new Promise<void>((resolve) => target.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
