import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { workspaceCopyCleanup, workspaceCopyGuest, workspaceCopyMarker } from "../../../packages/host/core/src/workspace/copy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("rejects unsafe upload archive entries without replacing the exact destination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-guest-")); roots.push(root);
  const destination = path.join(root, "destination"); await writeFile(destination, "preserve");
  for (const entries of [
    [{ path: "../escape", type: "file", mode: 0o600, size: 0 }],
    [{ path: ".", type: "directory", mode: 0o700 }, { path: "escape", type: "symlink", mode: 0o777, target: "../outside" }],
    [{ path: ".", type: "hardlink", mode: 0o600, target: "other" }]
  ]) {
    const result = await guest("receive", destination, archive(entries), true, true);
    expect(result.status).toBe(2); expect(result.stdout).toHaveLength(0);
    expect(result.stderr).toMatch(/unsafe|unsupported/);
    expect(await readFile(destination, "utf8")).toBe("preserve");
  }
  expect((await readdir(root)).filter((name) => name.startsWith(".dim-copy"))).toEqual([]);
});

it("rejects portable symlink escapes, trailing bytes, and oversized declared payloads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-guest-framing-")); roots.push(root);
  const destination = path.join(root, "destination"); await writeFile(destination, "preserve");
  for (const [index, entries] of ["C:/outside", "C:\\outside", "\\\\server\\share", "//server/share", "..\\outside"].map((target) => [
    { path: ".", type: "directory", mode: 0o700 }, { path: "link", type: "symlink", mode: 0o777, target }
  ]).entries()) {
    const result = await guest("receive", destination, archive(entries), true, true);
    expect(result.status, String(index)).toBe(2); expect(result.stderr).toMatch(/unsafe copy archive symlink/);
  }
  const trailing = await guest("receive", destination, Buffer.concat([archive([{ path: ".", type: "file", mode: 0o600, size: 0 }]), Buffer.from([1])]), false, true);
  expect(trailing.status).toBe(2); expect(trailing.stderr).toMatch(/trailing data/);
  const oversized = await guest("receive", destination, archive([{ path: ".", type: "file", mode: 0o600, size: 64 * 1024 * 1024 * 1024 + 1 }]), false, true);
  expect(oversized.status).toBe(2); expect(oversized.stderr).toMatch(/payload exceeds/);
  const longTarget = await guest("receive", destination, archive([
    { path: ".", type: "directory", mode: 0o700 }, { path: "link", type: "symlink", mode: 0o777, target: "é".repeat(3000) }
  ]), true, true);
  expect(longTarget.status).toBe(2); expect(longTarget.stderr).toMatch(/unsafe copy archive symlink/);
  const longPath = await guest("receive", destination, archive([
    { path: ".", type: "directory", mode: 0o700 }, { path: "é".repeat(3000), type: "file", mode: 0o600, size: 0 }
  ]), true, true);
  expect(longPath.status).toBe(2); expect(longPath.stderr).toMatch(/invalid copy archive entry/);
  expect(await readFile(destination, "utf8")).toBe("preserve");
});

it("creates a private staging directory before reading archive entry modes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-guest-stage-")); roots.push(root);
  const destination = path.join(root, "destination"); const token = randomUUID(); const staging = path.join(root, `.dim-copy-${token}`);
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyGuest, "receive", destination, "1", "0", workspaceCopyMarker, "helper", token], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await created(staging); expect((await lstat(staging)).mode & 0o777).toBe(0o700);
  child.stdin.end(archive([{ path: ".", type: "directory", mode: 0o777 }]));
  const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect(status, stderr).toBe(0); expect((await lstat(destination)).mode & 0o777).toBe(0o777);
});

it("cleanup stops an owned pre-promotion helper before removing only its staging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-guest-cancel-stage-")); roots.push(root);
  const destination = path.join(root, "destination"); await writeFile(destination, "old");
  const token = randomUUID(); const staging = path.join(root, `.dim-copy-${token}`);
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyGuest, "receive", destination, "1", "1", workspaceCopyMarker, "helper", token], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  await created(staging);
  const cleanup = await runCleanup(destination, token);
  expect(cleanup.status, cleanup.stderr).toBe(0);
  await closed;
  expect(await readFile(destination, "utf8")).toBe("old");
  await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
});

it("cleanup restores old data after cancellation following the backup rename", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-guest-cancel-backup-")); roots.push(root);
  const destination = path.join(root, "destination"), token = randomUUID();
  const staging = path.join(root, `.dim-copy-${token}`), stage = path.join(staging, "payload"), backup = path.join(root, `.dim-copy-backup-${token}`);
  await writeFile(destination, "old"); await mkdir(staging, { mode: 0o700 }); await writeFile(stage, "new"); await rename(destination, backup);
  const cleanup = await runCleanup(destination, token);
  expect(cleanup.status, cleanup.stderr).toBe(0); expect(await readFile(destination, "utf8")).toBe("old");
  await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" }); await expect(lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects hard-linked guest files before emitting a completed download archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-guest-hardlink-")); roots.push(root);
  const source = path.join(root, "source"); await mkdir(source); await writeFile(path.join(source, "file"), "data");
  await link(path.join(source, "file"), path.join(source, "hard"));
  const result = await guest("send", source, Buffer.alloc(0), true, false);
  expect(result.status).toBe(2); expect(result.stderr).toMatch(/hard-linked/);
});

async function guest(direction: "send" | "receive", operand: string, input: Buffer, recursive: boolean, overwrite: boolean) {
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyGuest, direction, operand,
    recursive ? "1" : "0", overwrite ? "1" : "0", workspaceCopyMarker, "helper", randomUUID()], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = []; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.stdin.end(input);
  const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { status, stdout: Buffer.concat(stdout), stderr };
}

async function runCleanup(operand: string, token: string): Promise<{ readonly status: number | null; readonly stderr: string }> {
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspaceCopyCleanup, operand, workspaceCopyMarker, "cleanup", token], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { status, stderr };
}

function archive(entries: readonly Record<string, unknown>[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("DIMCP1\0", "ascii")];
  for (const entry of entries) {
    const encoded = Buffer.from(JSON.stringify(entry)); const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
    chunks.push(length, encoded);
  }
  chunks.push(Buffer.alloc(4)); return Buffer.concat(chunks);
}

async function created(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = () => { if (!done) { done = true; watcher.close(); resolve(); } };
    const watcher = watch(path.dirname(file), (event, name) => { if (event === "rename" && name === path.basename(file)) finish(); });
    watcher.once("error", reject);
    void access(file).then(finish).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { watcher.close(); reject(error); }
    });
  });
}
