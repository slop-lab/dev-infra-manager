import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { NativeProjectRegistration } from "./native-project-registry-state.js";

const markerName = ".dim-native-project-owner";
const stagingPrefix = ".dim-native-project-";

export function nativeProjectStagingName(provisioningNonce: string): string {
  return `${stagingPrefix}${provisioningNonce}`;
}

export function nativeProjectStorageNames(
  registrations: readonly NativeProjectRegistration[]
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const registration of registrations) {
    names.add(registration.projectId);
    names.add(nativeProjectStagingName(registration.provisioningNonce));
  }
  return names;
}

export async function prepareOwnedNativeProjectStorage(
  storageRoot: string,
  registration: NativeProjectRegistration
): Promise<void> {
  const projectRoot = join(storageRoot, registration.projectId);
  const staging = join(storageRoot, nativeProjectStagingName(registration.provisioningNonce));
  if (await pathExists(projectRoot)) {
    await assertOwnerMarker(projectRoot, registration);
    if (await pathExists(staging)) throw new NativeProjectStorageError("native Project has conflicting staging storage");
    return;
  }
  if (!await pathExists(staging)) {
    await mkdir(staging, { mode: 0o700 });
    await writeOwnerMarker(staging, registration);
    await syncDirectory(staging);
  } else {
    await assertOwnerMarker(staging, registration);
  }
  await rename(staging, projectRoot);
  await syncDirectory(storageRoot);
}

export async function assertOwnedNativeProjectStorage(
  storageRoot: string,
  registration: NativeProjectRegistration
): Promise<void> {
  await assertOwnerMarker(join(storageRoot, registration.projectId), registration);
}

async function writeOwnerMarker(root: string, registration: NativeProjectRegistration): Promise<void> {
  const handle = await open(
    join(root, markerName),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o400
  );
  try {
    await handle.writeFile(markerBytes(registration), "utf8");
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertOwnerMarker(root: string, registration: NativeProjectRegistration): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
    || (metadata.mode & 0o777) !== 0o700) {
    throw new NativeProjectStorageError("native Project storage ownership is invalid");
  }
  const handle = await open(join(root, markerName), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP")) {
      throw new NativeProjectStorageError("native Project storage owner marker is invalid");
    }
    throw error;
  });
  try {
    const markerMetadata = await handle.stat();
    const bytes = await handle.readFile("utf8");
    if (!markerMetadata.isFile() || (markerMetadata.mode & 0o777) !== 0o400 || bytes !== markerBytes(registration)) {
      throw new NativeProjectStorageError("native Project storage owner marker is invalid");
    }
  } finally {
    await handle.close();
  }
}

function markerBytes(registration: NativeProjectRegistration): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    serviceId: registration.serviceId,
    projectId: registration.projectId,
    provisioningNonce: registration.provisioningNonce
  })}\n`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new NativeProjectStorageError("native Git requires a Linux user identity");
  return uid;
}

export class NativeProjectStorageError extends Error {
  readonly name = "NativeProjectStorageError";
}
