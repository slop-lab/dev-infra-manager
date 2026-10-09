import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";

export type NativeGitBundleMarker = {
  readonly schemaVersion: 1;
  readonly stateFormat: 8;
  readonly database: string;
  readonly schemaManifestSha256: string;
};

export async function publishNativeGitBundleMarker(path: string, marker: NativeGitBundleMarker): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.chmod(0o444);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function readNativeGitBundleMarker(
  path: string,
  expected: NativeGitBundleMarker
): Promise<NativeGitBundleMarker> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new NativeGitBundleMarkerError("native Git bundle state marker must be a regular file");
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new NativeGitBundleMarkerError("native Git bundle state marker is invalid");
      throw error;
    }
    if (!isRecord(value) || Object.keys(value).length !== 4
      || value.schemaVersion !== expected.schemaVersion || value.stateFormat !== expected.stateFormat
      || value.database !== expected.database || value.schemaManifestSha256 !== expected.schemaManifestSha256) {
      throw new NativeGitBundleMarkerError("native Git bundle state marker is invalid");
    }
    return expected;
  } finally {
    await handle.close();
  }
}

export async function syncNativeGitBundlePath(path: string, directory: boolean): Promise<void> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class NativeGitBundleMarkerError extends Error {
  readonly name = "NativeGitBundleMarkerError";
}
