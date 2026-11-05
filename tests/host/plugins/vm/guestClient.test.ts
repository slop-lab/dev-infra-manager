import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { workspaceCopyGuest } from "../../../../packages/host/core/src/workspace/copy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const client = fileURLToPath(new URL("../../../../packages/host/plugins/vm/src/assets/dim-vm.mjs", import.meta.url));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-guest-client-")); roots.push(root);
  const home = path.join(root, "home"), credentialDirectory = path.join(home, ".config/dim/vms");
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const requests: Array<{ readonly path: string; readonly body: Buffer }> = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks), url = request.url ?? ""; requests.push({ path: url, body });
    if (url.endsWith("/status")) { response.setHeader("content-type", "application/json"); response.end('{"vmId":"12345678-1234-4234-8234-123456789abc","vmName":"desktop","running":true,"permissions":["copy","exec","status"]}'); return; }
    if (url.endsWith("/exec")) { response.write(frame(1, Buffer.from(`stdout:${body}`))); response.write(frame(2, Buffer.from("stderr"))); response.end(frame(3, Buffer.from("7"))); return; }
    if (url.includes("direction=pull")) { response.end(archive(Buffer.from("artifact"))); return; }
    response.writeHead(204); response.end();
  })(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing guest client server");
  await writeFile(path.join(credentialDirectory, "desktop.json"), JSON.stringify({ schemaVersion: 2,
    grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1, vmId: "12345678-1234-4234-8234-123456789abc",
    vmName: "desktop", workspaceId: "12345678-1234-4234-8234-123456789abc", workspaceName: "dev",
    permissions: ["copy", "exec", "status"], token: "t".repeat(43), endpoint: `http://127.0.0.1:${address.port}`, consoleUrl: "http://127.0.0.1:8089" }), { mode: 0o600 });
  const copy = path.join(home, ".local/share/dim-vm/copy.cjs"); await mkdir(path.dirname(copy), { recursive: true });
  await writeFile(copy, `process.argv.splice(1,1);\n${workspaceCopyGuest}`, { mode: 0o700 });
  return { root, home, server, requests };
}

async function run(home: string, args: readonly string[], input = "") {
  const child = spawn(process.execPath, [client, ...args], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("missing child streams");
  const stdout: Buffer[] = [], stderr: Buffer[] = []; child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk))); child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(input); const [code] = await once(child, "close"); return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

it("prints help without requiring a VM credential", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-guest-client-help-")); roots.push(root);
  const result = await run(root, ["--help"]);
  expect({ code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }).toEqual({
    code: 0,
    stdout: "usage: dim-vm list|status|exec|push|pull|start|stop|console\n",
    stderr: ""
  });
});

it("uses a private credential for status and framed interactive exec", async () => {
  const f = await fixture();
  try {
    expect(JSON.parse((await run(f.home, ["status", "desktop"])).stdout.toString("utf8"))).toMatchObject({ running: true });
    const result = await run(f.home, ["exec", "desktop", "--", "cat"], "input");
    expect({ code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") })
      .toEqual({ code: 7, stdout: "stdout:input", stderr: "stderr" });
    await chmod(path.join(f.home, ".config/dim/vms/desktop.json"), 0o644);
    expect((await run(f.home, ["status", "desktop"])).code).toBe(2);
  } finally { f.server.close(); await once(f.server, "close"); }
});

it("pushes and pulls files with the shared DIMCP1 helper", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.root, "source.bin"), target = path.join(f.root, "target.bin"); await writeFile(source, "payload");
    const pushed = await run(f.home, ["push", "desktop", source, "uploads/result.bin"]);
    expect({ code: pushed.code, stderr: pushed.stderr.toString("utf8") }).toEqual({ code: 0, stderr: "" });
    expect(f.requests.find(({ path }) => path.includes("direction=push"))?.body.subarray(0, 7).toString("ascii")).toBe("DIMCP1\0");
    expect((await run(f.home, ["pull", "desktop", "outputs/result.bin", target])).code).toBe(0);
    expect(await readFile(target, "utf8")).toBe("artifact"); expect((await stat(target)).isFile()).toBe(true);
  } finally { f.server.close(); await once(f.server, "close"); }
});

function frame(channel: number, body: Buffer): Buffer { const header = Buffer.alloc(5); header.writeUInt8(channel); header.writeUInt32BE(body.length, 1); return Buffer.concat([header, body]); }
function archive(body: Buffer): Buffer { const magic = Buffer.from("DIMCP1\0", "ascii"), entry = Buffer.from(JSON.stringify({ path: ".", type: "file", mode: 0o600, size: body.length })); const length = Buffer.alloc(4); length.writeUInt32BE(entry.length); return Buffer.concat([magic, length, entry, body, Buffer.alloc(4)]); }
