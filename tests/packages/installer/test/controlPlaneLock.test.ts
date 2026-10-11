import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireControlPlaneStateLock,
  assertControlPlaneStateLock
} from "../../../../core/packages/installer/src/controlPlaneLock.js";

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];
const childSource = join(dirname(fileURLToPath(import.meta.url)), "controlPlaneLockChild.ts");

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("control-plane installer lock", () => {
  it("keeps the kernel lock in the installer process after the flock helper exits", async () => {
    // Given: one installer process has acquired the owner-recorded state-root lock.
    const root = await stateRoot();
    const holder = startChild(root);
    const holderPid = requiredPid(holder);
    const owner = JSON.parse((await outputLine(holder)).slice("acquired:".length));
    expect(owner).toEqual({ schemaVersion: 1, pid: holderPid, uid: currentUid(), startedAt: expect.any(String) });
    expect((await readFile(`/proc/${holderPid}/task/${holderPid}/children`, "utf8")).trim()).toBe("");
    const path = join(root, "install.lock");
    const ownerBefore = await readFile(path);
    expect(JSON.parse(ownerBefore.toString("utf8"))).toEqual(owner);
    const metadataBefore = await lstat(path);
    expect(metadataBefore.mode & 0o777).toBe(0o600);
    expect(metadataBefore.uid).toBe(currentUid());
    expect(metadataBefore.nlink).toBe(1);

    // When: a second process attempts the same lock.
    const contender = startChild(root);

    // Then: contention fails before changing state, and installer death releases the lock.
    expect(await outputLine(contender)).toMatch(/^rejected:.*locked/);
    await exited(contender);
    const metadataAfter = await lstat(path);
    expect((await readFile(path)).equals(ownerBefore)).toBe(true);
    expect([metadataAfter.dev, metadataAfter.ino, metadataAfter.uid, metadataAfter.mode, metadataAfter.nlink])
      .toEqual([metadataBefore.dev, metadataBefore.ino, metadataBefore.uid, metadataBefore.mode, metadataBefore.nlink]);
    holder.kill("SIGKILL");
    await exited(holder);
    const replacement = await acquireAfterClose(root);
    await replacement.close();
  });

  it("releases the descriptor lock exactly once when close is repeated", async () => {
    // Given: this process owns the descriptor-backed state lock.
    const root = await stateRoot();
    const lock = await acquireControlPlaneStateLock(root);

    // When: the lock is closed twice.
    await lock.close();
    await lock.close();

    // Then: another real process can acquire and close the lock.
    const replacement = startChild(root);
    expect(await outputLine(replacement)).toMatch(/^acquired:/);
    replacement.stdin?.end();
    await exited(replacement);
  });

  it("rejects a lock object after its locked inode is replaced", async () => {
    // Given: the pathname initially names the descriptor-locked inode.
    const root = await stateRoot();
    const lock = await acquireControlPlaneStateLock(root);
    const path = join(root, "install.lock");
    const displaced = join(root, "install.lock.displaced");

    // When: the pathname is replaced without changing the open descriptor.
    await rename(path, displaced);
    await writeFile(path, "replacement\n", { mode: 0o600 });

    // Then: the lock object cannot authorize state access through the replacement.
    expect(() => assertControlPlaneStateLock(lock, root)).toThrow(/not held/);
    await lock.close();
  });
});

async function stateRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dim-control-plane-lock-"));
  temporaryDirectories.push(directory);
  return join(directory, "state");
}

function startChild(root: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", childSource, root], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
}

function requiredPid(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("lock child PID is unavailable");
  return child.pid;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("lock tests require a Linux user identity");
  return uid;
}

async function outputLine(child: ChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline !== -1) resolve(output.slice(0, newline));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("\n")) reject(new Error(`lock child exited before output with ${code}`));
    });
  });
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function acquireAfterClose(root: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await acquireControlPlaneStateLock(root);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("locked") || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("unreachable lock retry exhaustion");
}
