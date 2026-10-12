import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { KernelGuard } from "./lifecycleLockGuard.js";
import { NativeQemuHostJournalError, parseNativeQemuHostJournalState,
  type NativeQemuHostJournalState } from "./nativeQemuHostJournalState.js";

const lockHolderScript = "flock --exclusive --nonblock 3 || exit 1\nprintf 'locked\\n'\ncat >/dev/null";

export { NativeQemuHostJournalError } from "./nativeQemuHostJournalState.js";
export type { NativeQemuHostJournalState } from "./nativeQemuHostJournalState.js";

export class NativeQemuHostJournal {
  readonly #path: string;
  readonly #directory: string;

  constructor(path: string) {
    if (path.length === 0) throw new NativeQemuHostJournalError("native QEMU host journal path is empty");
    this.#path = path;
    this.#directory = dirname(path);
  }

  async prepare(): Promise<void> {
    await this.#prepareDirectory();
  }

  async load(): Promise<NativeQemuHostJournalState | undefined> {
    await this.#prepareDirectory();
    let handle;
    try { handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (isMissing(error)) return undefined;
      throw new NativeQemuHostJournalError("native QEMU host journal is not a regular file", { cause: error });
    }
    try {
      const metadata = await handle.stat();
      requireOwnedFile(metadata, "journal");
      try { return parseNativeQemuHostJournalState(JSON.parse(await handle.readFile("utf8"))); }
      catch (error) {
        if (error instanceof SyntaxError) {
          throw new NativeQemuHostJournalError("native QEMU host journal is not JSON", { cause: error });
        }
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }

  async save(state: NativeQemuHostJournalState): Promise<void> {
    await this.#prepareDirectory();
    await assertExistingOwnedFile(this.#path, "journal");
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...state }), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      await syncDirectory(this.#directory);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async clear(): Promise<void> {
    await this.#prepareDirectory();
    await assertExistingOwnedFile(this.#path, "journal");
    try { await unlink(this.#path); }
    catch (error) { if (isMissing(error)) return; throw error; }
    await syncDirectory(this.#directory);
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("journal parent is not a directory");
    requireOwnerMode(metadata.uid, metadata.mode, 0o700, "journal parent");
  }
}

export async function acquireNativeQemuHostCapacityGuard(journalPath: string): Promise<KernelGuard> {
  const journal = new NativeQemuHostJournal(journalPath);
  await journal.prepare();
  const guardPath = `${journalPath}.guard`;
  let guardFile;
  try {
    guardFile = await open(guardPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    requireOwnedFile(await guardFile.stat(), "capacity guard");
  } catch (error) {
    await guardFile?.close();
    throw new NativeQemuHostJournalError("native QEMU host capacity guard is invalid", { cause: error });
  }
  const child = spawn("/bin/sh", ["-c", lockHolderScript], {
    stdio: ["pipe", "pipe", "pipe", guardFile.fd]
  });
  const stdin = child.stdin;
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdin === null || stdoutStream === null || stderrStream === null) {
    child.kill();
    throw new NativeQemuHostJournalError("native QEMU capacity guard pipes are unavailable");
  }
  stdoutStream.setEncoding("utf8");
  stderrStream.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  stdoutStream.on("data", (chunk: string) => { stdout += chunk; });
  stderrStream.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const pendingGuard = new Promise<KernelGuard | undefined>((resolve, reject) => {
    child.once("error", (error) => reject(new NativeQemuHostJournalError(
      `cannot start native QEMU capacity guard: ${error.message}`)));
    stdoutStream.on("data", () => {
      if (!stdout.includes("locked\n")) return;
      resolve({ release: async () => {
        stdin.end();
        const result = await exited;
        if (result.code !== 0) {
          throw new NativeQemuHostJournalError(
            `native QEMU capacity guard exited with ${String(result.code ?? result.signal)}`);
        }
      } });
    });
    void exited.then((result) => {
      if (result.code === 1) resolve(undefined);
      else if (!stdout.includes("locked\n")) reject(new NativeQemuHostJournalError(
        `native QEMU capacity guard failed with ${String(result.code ?? result.signal)}: ${stderr.trim()}`));
    });
  });
  await guardFile.close();
  const guard = await pendingGuard;
  if (guard === undefined) {
    throw new NativeQemuHostJournalError("native QEMU capacity is already served by another process");
  }
  return guard;
}

export async function acquireNativeQemuHostCapacityGuards(
  journalPaths: readonly string[]
): Promise<readonly KernelGuard[]> {
  const guards: KernelGuard[] = [];
  try {
    for (const journalPath of journalPaths) {
      guards.push(await acquireNativeQemuHostCapacityGuard(journalPath));
    }
  } catch (error) {
    await Promise.all(guards.map((guard) => guard.release()));
    throw error;
  }
  return guards;
}

function requireOwnerMode(uid: number, mode: number, required: number, label: string): void {
  const owner = process.getuid?.();
  if (owner === undefined || uid !== owner || (mode & 0o777) !== required) invalid(`${label} ownership or mode is invalid`);
}
function requireOwnedFile(metadata: Stats, label: string): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    invalid(`${label} is invalid`);
  }
  requireOwnerMode(metadata.uid, metadata.mode, 0o600, label);
}
async function assertExistingOwnedFile(path: string, label: string): Promise<void> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { if (isMissing(error)) return; throw error; }
  requireOwnedFile(metadata, label);
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}
function invalid(message: string): never { throw new NativeQemuHostJournalError(`native QEMU host ${message}`); }
