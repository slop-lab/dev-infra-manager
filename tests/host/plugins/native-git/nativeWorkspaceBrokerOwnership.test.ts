import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { retireNativeWorkspaceBrokers } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceBrokerOwnership.js";
import { ensureNativeWorkspaceBroker } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceBrokerProcess.js";
import { attachmentRecord } from "./nativeProjectFixture.js";
import { nativeWorkspaceBrokerHealth, writeNativeWorkspaceAttachment } from "../../../../packages/host/plugins/native-git/src/nativeWorkspaceAttachment.js";

it("retires only an exact same-host broker entrypoint and attachment, leaving other processes alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-broker-ownership-"));
  const children: ChildProcess[] = [];
  try {
    const broker = join(root, "nativeWorkspaceBrokerProcess.mjs"), unrelated = join(root, "unrelated.mjs");
    await writeFile(broker, 'import { createServer } from "node:http"; import { readFileSync } from "node:fs"; const config = JSON.parse(readFileSync(process.argv[2], "utf8")); const server = createServer((request, response) => response.end(config.revision)); server.listen(config.port, "127.0.0.1", () => process.stdout.write(String(server.address().port)));');
    await writeFile(unrelated, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
    const attachment = join(root, "exact-attachment.json");
    const otherAttachment = join(root, "other.json");
    await writeFile(attachment, JSON.stringify({ port: 0, revision: "old" }));
    await writeFile(otherAttachment, JSON.stringify({ port: 0, revision: "other" }));
    const launch = async (executable: string, file: string) => {
      const child = spawn(process.execPath, [executable, file], { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
      const [output] = await once(child.stdout!, "data"); return { child, output: String(output) };
    };
    const stale = await launch(broker, attachment), differentAttachment = await launch(broker, otherAttachment), otherProcess = await launch(unrelated, attachment);
    const endpoint = `http://127.0.0.1:${stale.output}`;
    expect(await (await fetch(endpoint)).text()).toBe("old");
    const exited = once(stale.child, "exit");
    expect(await retireNativeWorkspaceBrokers([broker], attachment)).toBe(1);
    await exited;
    expect(differentAttachment.child.exitCode).toBeNull(); expect(otherProcess.child.exitCode).toBeNull();
    process.kill(differentAttachment.child.pid!, 0); process.kill(otherProcess.child.pid!, 0);
    expect(await retireNativeWorkspaceBrokers([broker], attachment)).toBe(0);
    await writeFile(attachment, JSON.stringify({ port: Number(stale.output), revision: "new" }));
    const replacement = await launch(broker, attachment);
    expect(replacement.output).toBe(stale.output);
    expect(await (await fetch(endpoint, { headers: { connection: "close" } })).text()).toBe("new");
  } finally {
    await Promise.all(children.map(async (child) => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } }));
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses stale health from an unrelated listener and leaves that listener running", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-broker-busy-"));
  const attachment = attachmentRecord(root, randomUUID());
  const server = createServer((_request, response) => response.end(nativeWorkspaceBrokerHealth(attachment)));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener address");
    attachment.port = address.port;
    await writeNativeWorkspaceAttachment(attachment);
    await expect(ensureNativeWorkspaceBroker(attachment, AbortSignal.timeout(1200))).rejects.toThrow();
    expect(server.listening).toBe(true);
    expect((await fetch(`http://127.0.0.1:${address.port}/health`)).status).toBe(200);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});
