import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceCopyCleanup, workspaceCopyGuest, workspaceCopyMarker, workspaceCopyProcessArgumentsMatch } from "../../../../packages/host/core/src/workspace/copy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.sequential("VM copy physical containment", () => {
it("matches only exact ordinary and scoped helper process arguments", () => {
  const token = randomUUID(), root = "/home/dim";
  expect(workspaceCopyProcessArgumentsMatch([], workspaceCopyMarker, token)).toBe(false);
  expect(workspaceCopyProcessArgumentsMatch([workspaceCopyMarker, "helper"], workspaceCopyMarker, token)).toBe(false);
  expect(workspaceCopyProcessArgumentsMatch(["node", workspaceCopyMarker, "cleanup", token], workspaceCopyMarker, token)).toBe(false);
  expect(workspaceCopyProcessArgumentsMatch(["node", workspaceCopyMarker, "helper", token], workspaceCopyMarker, token)).toBe(true);
  expect(workspaceCopyProcessArgumentsMatch(["node", workspaceCopyMarker, "helper", token, root], workspaceCopyMarker, token, root)).toBe(true);
});

it("rejects reading through an intermediate symlink outside the granted VM home", async () => {
  const fixture = await copyFixture();
  await writeFile(path.join(fixture.outside, "secret"), "outside-secret");
  await symlink(fixture.outside, path.join(fixture.home, "link"));
  const result = await runHelper("send", path.join(fixture.home, "link/secret"), fixture.home);
  expect(result.code).toBe(2);
  expect(result.stdout.toString("utf8")).not.toContain("outside-secret");
});

it("rejects writing through an intermediate symlink outside the granted VM home", async () => {
  const fixture = await copyFixture();
  await symlink(fixture.outside, path.join(fixture.home, "link"));
  const result = await runHelper("receive", path.join(fixture.home, "link/new"), fixture.home, fileArchive("payload"));
  expect(result.code).toBe(2);
  await expect(stat(path.join(fixture.outside, "new"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves ordinary nested reads and writes inside the granted VM home", async () => {
  const fixture = await copyFixture();
  const nested = path.join(fixture.home, "projects/current"); await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "source"), "inside-payload");
  const sent = await runHelper("send", path.join(nested, "source"), fixture.home);
  expect({ code: sent.code, archive: sent.stdout.toString("utf8") }).toMatchObject({ code: 0, archive: expect.stringContaining("inside-payload") });
  const received = await runHelper("receive", path.join(nested, "destination"), fixture.home, fileArchive("received-payload"));
  expect(received.code).toBe(0);
  expect(await readFile(path.join(nested, "destination"), "utf8")).toBe("received-payload");
});

it("reads from a read-only source parent without creating tracking files", async () => {
  const fixture = await copyFixture(), sourceParent = path.join(fixture.home, "read-only");
  await mkdir(sourceParent); await writeFile(path.join(sourceParent, "artifact"), "read-only-payload"); await chmod(sourceParent, 0o555);
  try {
    const result = await runHelper("send", path.join(sourceParent, "artifact"), fixture.home);
    expect({ code: result.code, archive: result.stdout.toString("utf8") }).toMatchObject({ code: 0, archive: expect.stringContaining("read-only-payload") });
  } finally { await chmod(sourceParent, 0o700); }
});

it("scoped cleanup identifies and terminates an active physical-root helper", async () => {
  const fixture = await copyFixture(), target = path.join(fixture.home, "nested/destination");
  await mkdir(path.dirname(target), { recursive: true });
  const token = randomUUID();
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyGuest,
    "receive", target, "0", "1", workspaceCopyMarker, "helper", token, fixture.home], { stdio: ["pipe", "ignore", "pipe"] });
  if (!child.stdin) throw new Error("missing scoped helper stdin");
  const helperClosed = once(child, "close", { signal: AbortSignal.timeout(2_000) });
  try {
    child.stdin.write(Buffer.from("DIMCP1\0", "ascii"));
    const staging = path.join(path.dirname(target), `.dim-copy-${token}`); await waitForPath(staging);
    if (child.pid === undefined) throw new Error("missing scoped helper pid");
    const commandLine = (await readFile(`/proc/${child.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    expect(commandLine.slice(-4)).toEqual([workspaceCopyMarker, "helper", token, fixture.home]);
    const cleanup = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyCleanup,
      target, workspaceCopyMarker, "cleanup", token, fixture.home], { stdio: ["ignore", "pipe", "pipe"] });
    const cleanupError: Buffer[] = []; cleanup.stderr?.on("data", (chunk) => cleanupError.push(Buffer.from(chunk)));
    const [cleanupCode] = await once(cleanup, "close");
    expect(cleanupCode, Buffer.concat(cleanupError).toString("utf8")).toBe(0);
    const [helperCode, helperSignal] = await helperClosed;
    expect(helperCode).toBeNull(); expect(helperSignal).toBe("SIGTERM");
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { child.stdin.destroy(); if (child.exitCode === null) child.kill("SIGKILL"); }
});
});

async function copyFixture(): Promise<{ readonly home: string; readonly outside: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-copy-containment-")); roots.push(root);
  const home = path.join(root, "home"), outside = path.join(root, "outside");
  await mkdir(home, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  return { home, outside };
}

async function runHelper(direction: "send" | "receive", operand: string, physicalRoot: string, input?: Buffer) {
  const token = randomUUID();
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyGuest,
    direction, operand, "0", "1", workspaceCopyMarker, "helper", token, physicalRoot], { stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("missing copy helper streams");
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk))); child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(input); const [code] = await once(child, "close");
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

function fileArchive(body: string): Buffer {
  const payload = Buffer.from(body), entry = Buffer.from(JSON.stringify({ path: ".", type: "file", mode: 0o600, size: payload.length }));
  const length = Buffer.alloc(4); length.writeUInt32BE(entry.length);
  return Buffer.concat([Buffer.from("DIMCP1\0", "ascii"), length, entry, payload, Buffer.alloc(4)]);
}

async function waitForPath(target: string): Promise<void> {
  const signal = AbortSignal.timeout(2_000);
  for (;;) {
    signal.throwIfAborted();
    try { await stat(target); return; }
    catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
