import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  symlink
} from "node:fs/promises";
import path from "node:path";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const descendantFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const typeMask = BigInt(constants.S_IFMT);

export async function snapshotInputs({ inputs, inputsRoot, sourceRoot, signal }) {
  const snapshots = [];
  for (const input of inputs) {
    signal.throwIfAborted();
    const source = await open(input.path, directoryFlags);
    try {
      const openedPath = await realpath(fdPath(source.fd));
      if (!isWithin(openedPath, sourceRoot)) {
        throw new Error(`input '${input.name}' resolves outside ${sourceRoot}`);
      }
      const destinationPath = path.join(inputsRoot, input.name);
      await mkdir(destinationPath, { mode: 0o700 });
      const destination = await open(destinationPath, directoryFlags);
      try {
        await destination.chmod(0o700);
        await copyDirectory(source, destination, input.name, signal);
      } finally {
        await destination.close();
      }
      snapshots.push({ name: input.name, path: destinationPath });
    } finally {
      await source.close();
    }
  }
  return snapshots;
}

async function copyDirectory(source, destination, inputName, signal) {
  const sourceDirectory = fdPath(source.fd);
  const destinationDirectory = fdPath(destination.fd);
  for await (const entry of await opendir(sourceDirectory)) {
    signal.throwIfAborted();
    const { name } = entry;
    const sourcePath = path.join(sourceDirectory, name);
    const destinationPath = path.join(destinationDirectory, name);
    const before = await lstat(sourcePath, { bigint: true });
    if (before.isSymbolicLink()) {
      await copySymbolicLink(sourcePath, destinationPath, before, inputName, signal);
      continue;
    }
    if (!before.isDirectory() && !before.isFile()) throw unsupported(inputName);
    const flags = descendantFlags | (before.isDirectory() ? constants.O_DIRECTORY : 0);
    const child = await open(sourcePath, flags);
    try {
      const metadata = await child.stat({ bigint: true });
      if (!sameIdentity(before, metadata)) {
        throw new Error(`input '${inputName}' changed while snapshotting`);
      }
      if (metadata.isDirectory()) {
        await copyChildDirectory(child, destinationPath, inputName, signal);
      } else if (metadata.isFile()) {
        await copyRegularFile(child, destinationPath, metadata, signal);
      } else {
        throw unsupported(inputName);
      }
    } finally {
      await child.close();
    }
  }
}

async function copyChildDirectory(source, destinationPath, inputName, signal) {
  await mkdir(destinationPath, { mode: 0o700 });
  const destination = await open(destinationPath, directoryFlags);
  try {
    await destination.chmod(0o700);
    await copyDirectory(source, destination, inputName, signal);
  } finally {
    await destination.close();
  }
}

async function copyRegularFile(source, destinationPath, metadata, signal) {
  const destination = await open(
    destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        signal.throwIfAborted();
        const result = await destination.write(buffer, written, bytesRead - written, null);
        written += result.bytesWritten;
      }
    }
    await destination.chmod(Number(metadata.mode & 0o777n));
  } finally {
    await destination.close();
  }
}

async function copySymbolicLink(sourcePath, destinationPath, before, inputName, signal) {
  const target = await readlink(sourcePath);
  const after = await lstat(sourcePath, { bigint: true });
  if (!after.isSymbolicLink() || !sameIdentity(before, after)) {
    throw new Error(`input '${inputName}' changed while snapshotting`);
  }
  signal.throwIfAborted();
  await symlink(target, destinationPath);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    (left.mode & typeMask) === (right.mode & typeMask);
}

function fdPath(descriptor) {
  return `/proc/self/fd/${descriptor}`;
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function unsupported(inputName) {
  return new Error(`input '${inputName}' contains an unsupported entry type`);
}
