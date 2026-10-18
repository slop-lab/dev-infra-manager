import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UserError, WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { createNativeWorkspaceBroker } from "./nativeWorkspaceBroker.js";
import { nativeWorkspaceAttachmentFile, nativeWorkspaceBrokerHealth, readNativeWorkspaceAttachment,
  type NativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";

export async function ensureNativeWorkspaceBroker(attachment: NativeWorkspaceAttachment, signal?: AbortSignal): Promise<void> {
  const ready = async (): Promise<boolean> => {
    try {
      const response = await fetch(`http://${attachment.gateway}:${attachment.port}/health`, {
        headers: { authorization: `Basic ${Buffer.from(`dim:${attachment.grant}`).toString("base64")}` },
        signal: AbortSignal.timeout(500)
      });
      return response.status === 200 && await response.text() === nativeWorkspaceBrokerHealth(attachment);
    } catch { return false; }
  };
  if (await ready()) return;
  const file = nativeWorkspaceAttachmentFile(attachment.managedStateRoot, attachment.workspaceId);
  const compiled = fileURLToPath(new URL("./nativeWorkspaceBrokerProcess.js", import.meta.url));
  const executable = await stat(compiled).then(() => compiled, () => fileURLToPath(new URL("./nativeWorkspaceBrokerProcess.ts", import.meta.url)));
  const deadline = Date.now() + 10_000;
  let nextAttempt = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await ready()) return;
    if (Date.now() >= nextAttempt) {
      // A discarded workspace's old broker may still be releasing a reused bridge address.
      // Retry startup until its bounded lifetime check has closed that listener.
      const log = await open(path.join(path.dirname(file), `${attachment.workspaceId}.broker.log`), "a", 0o600);
      try {
        const child = spawn(process.execPath, [...process.execArgv, executable, file], {
          detached: true, stdio: ["ignore", "ignore", log.fd], env: process.env
        });
        child.on("error", () => {}); child.unref();
      } finally { await log.close(); }
      nextAttempt = Date.now() + 1000;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new UserError("native workspace Git broker did not become ready; inspect its private broker log");
}

async function serve(file: string): Promise<void> {
  const attachment = await readNativeWorkspaceAttachment(file);
  const server = createNativeWorkspaceBroker(attachment);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(attachment.port, attachment.gateway, resolve);
  });
  const store = new WorkspaceStore(attachment.workspaceStateRoot);
  let closing = false;
  const close = () => {
    if (closing) return; closing = true; clearInterval(timer);
    server.close(); server.closeAllConnections();
  };
  const timer = setInterval(async () => {
    try {
      const record = await store.read(attachment.workspaceName);
      if (record.id !== attachment.workspaceId || record.phase === "discarding") close();
    } catch { close(); }
  }, 1000);
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error("usage: nativeWorkspaceBrokerProcess ATTACHMENT_FILE");
  serve(file).catch(() => { console.error("native workspace Git broker failed to start"); process.exitCode = 1; });
}
