import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const maximumStateBytes = 4 * 1024 * 1024;
const stagingPattern = /^\.state\.json\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const publicationPattern = /^\.state\.json\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish$/;

export type NativeQemuAuthorityPublicationFaults = {
  readonly beforeFileSync?: () => void | Promise<void>;
  readonly beforeRename?: () => void | Promise<void>;
  readonly beforeDirectorySync?: () => void | Promise<void>;
};

type StateCodec<State> = {
  readonly parse: (value: unknown) => State;
  readonly isSuccessor: (current: State | undefined, candidate: State) => boolean;
};

type StateFile<State> = {
  readonly metadata: Stats;
  readonly serialized: string;
  readonly state: State;
};

export async function readNativeQemuAuthorityStateFile<State>(
  repository: string,
  codec: StateCodec<State>
): Promise<State | undefined> {
  const directory = join(repository, "dim-authoritative-qemu");
  if (!await pathExists(directory)) return undefined;
  await assertPrivateDirectory(directory);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const finalEntry = entries.find(({ name }) => name === "state.json");
  const stagingEntries = entries.filter(({ name }) => stagingPattern.test(name));
  const publicationEntries = entries.filter(({ name }) => publicationPattern.test(name));
  if (entries.some((entry) => !entry.isFile() || (entry.name !== "state.json"
    && !stagingPattern.test(entry.name) && !publicationPattern.test(entry.name)))
    || stagingEntries.length > 1 || publicationEntries.length > 1) {
    throw new NativeQemuAuthorityFilesError("QEMU authority store layout is invalid");
  }
  const final = finalEntry === undefined ? undefined : await readState(join(directory, "state.json"), codec.parse);
  if (stagingEntries.length === 0 && publicationEntries.length === 0) {
    if (final === undefined) throw new NativeQemuAuthorityFilesError("QEMU authority state file is missing");
    assertSingleLink(final.metadata);
    return final.state;
  }
  const stagingName = stagingEntries[0]?.name;
  if (stagingName === undefined) {
    throw new NativeQemuAuthorityFilesError("QEMU authority publication has no staging evidence");
  }
  const staged = await readState(join(directory, stagingName), codec.parse);
  assertDigest(stagingName, staged.serialized, stagingPattern);
  const publicationName = publicationEntries[0]?.name;
  if (publicationName !== undefined) {
    await recoverBeforeRename(directory, stagingName, publicationName, staged, final, codec);
    return staged.state;
  }
  if (final === undefined || !sameInode(staged.metadata, final.metadata)
    || staged.metadata.nlink !== 2 || final.metadata.nlink !== 2
    || staged.serialized !== final.serialized) {
    throw new NativeQemuAuthorityFilesError("QEMU authority staging is not a proved publication");
  }
  await syncDirectory(directory);
  await unlink(join(directory, stagingName));
  await syncDirectory(directory);
  return staged.state;
}

export async function publishNativeQemuAuthorityState(
  repository: string,
  serialized: string,
  faults: NativeQemuAuthorityPublicationFaults
): Promise<void> {
  if (Buffer.byteLength(serialized, "utf8") > maximumStateBytes) {
    throw new NativeQemuAuthorityFilesError("QEMU authority state exceeds the storage bound");
  }
  const directory = join(repository, "dim-authoritative-qemu");
  await ensurePrivateDirectory(directory);
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  const identity = randomUUID();
  const stagingName = `.state.json.${digest}.${identity}.tmp`;
  const publicationName = `.state.json.${digest}.${identity}.publish`;
  const stagingPath = join(directory, stagingName);
  const publicationPath = join(directory, publicationName);
  const file = await open(stagingPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(serialized, "utf8");
    await file.chmod(0o600);
    await faults.beforeFileSync?.();
    await file.sync();
  } finally {
    await file.close();
  }
  await link(stagingPath, publicationPath);
  await faults.beforeRename?.();
  await rename(publicationPath, join(directory, "state.json"));
  await faults.beforeDirectorySync?.();
  await syncDirectory(directory);
  await unlink(stagingPath);
  await syncDirectory(directory);
}

async function recoverBeforeRename<State>(
  directory: string,
  stagingName: string,
  publicationName: string,
  staged: StateFile<State>,
  final: StateFile<State> | undefined,
  codec: StateCodec<State>
): Promise<void> {
  assertMatchingNames(stagingName, publicationName);
  const publication = await readState(join(directory, publicationName), codec.parse);
  if (!sameInode(staged.metadata, publication.metadata) || staged.metadata.nlink !== 2
    || publication.metadata.nlink !== 2 || staged.serialized !== publication.serialized
    || !codec.isSuccessor(final?.state, staged.state)) {
    throw new NativeQemuAuthorityFilesError("QEMU authority rename intent is not proved");
  }
  if (final !== undefined) assertSingleLink(final.metadata);
  await rename(join(directory, publicationName), join(directory, "state.json"));
  await syncDirectory(directory);
  await unlink(join(directory, stagingName));
  await syncDirectory(directory);
}

async function readState<State>(path: string, parse: (value: unknown) => State): Promise<StateFile<State>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    assertPrivateFile(metadata);
    if (metadata.size > maximumStateBytes) {
      throw new NativeQemuAuthorityFilesError("QEMU authority state exceeds the storage bound");
    }
    const serialized = await file.readFile("utf8");
    try {
      return { metadata, serialized, state: parse(JSON.parse(serialized)) };
    } catch (error) {
      throw new NativeQemuAuthorityFilesError("QEMU authority state is invalid", { cause: error });
    }
  } finally {
    await file.close();
  }
}

function assertMatchingNames(stagingName: string, publicationName: string): void {
  const staged = stagingPattern.exec(stagingName);
  const publication = publicationPattern.exec(publicationName);
  if (staged?.[1] !== publication?.[1] || staged?.[2] !== publication?.[2]) {
    throw new NativeQemuAuthorityFilesError("QEMU authority publication identity conflicts");
  }
}

function assertDigest(name: string, serialized: string, pattern: RegExp): void {
  const expected = pattern.exec(name)?.[1];
  const actual = createHash("sha256").update(serialized, "utf8").digest("hex");
  if (expected !== actual) throw new NativeQemuAuthorityFilesError("QEMU authority staging digest conflicts");
}

function assertPrivateFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
    || (metadata.mode & 0o777) !== 0o600) {
    throw new NativeQemuAuthorityFilesError("QEMU authority state must be a caller-owned mode-0600 regular file");
  }
}

function assertSingleLink(metadata: Stats): void {
  if (metadata.nlink !== 1) throw new NativeQemuAuthorityFilesError("QEMU authority state must have one owner");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
    || (metadata.mode & 0o777) !== 0o700) {
    throw new NativeQemuAuthorityFilesError("QEMU authority store must be a caller-owned mode-0700 directory");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new NativeQemuAuthorityFilesError("QEMU authority state requires a Linux identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class NativeQemuAuthorityFilesError extends Error {
  readonly name = "NativeQemuAuthorityFilesError";
}
