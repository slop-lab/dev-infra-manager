import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { UserError } from "./errors.js";
import {
  metadataChanged,
  openOrdinaryStateDirectory,
  openOrdinaryStateFile,
  type OpenedStateFile
} from "./nativeOrdinaryBundleFilesystem.js";

const databaseName = "ordinary-ci.sqlite3";
const markerName = "state-format.json";
const snapshotAttempts = 3;

type OpenedNamedFile = {
  readonly name: string;
  readonly stateFile: OpenedStateFile;
};

export type NativeOrdinaryBundleSnapshot = {
  readonly database: string;
  readonly markerJson: string;
};

class SnapshotChangedError extends Error {
  readonly name = "SnapshotChangedError";
}

export async function copyNativeOrdinaryBundleSnapshot(
  stateDirectory: string,
  copyRoot: string,
  expectedEntries: readonly string[]
): Promise<NativeOrdinaryBundleSnapshot> {
  for (let attempt = 1; attempt <= snapshotAttempts; attempt += 1) {
    const copyDirectory = join(copyRoot, `attempt-${attempt}`);
    await mkdir(copyDirectory, { mode: 0o700 });
    try {
      const markerJson = await copySnapshotAttempt(stateDirectory, copyDirectory, expectedEntries);
      return { database: join(copyDirectory, databaseName), markerJson };
    } catch (error) {
      if (!(error instanceof SnapshotChangedError)) throw error;
      if (attempt === snapshotAttempts) {
        throw new UserError("ordinary CI database state changed while it was inspected", { cause: error });
      }
      await rm(copyDirectory, { recursive: true, force: true });
    }
  }
  throw new UserError("ordinary CI database state snapshot attempts were exhausted");
}

async function copySnapshotAttempt(
  stateDirectory: string,
  copyDirectory: string,
  expectedEntries: readonly string[]
): Promise<string> {
  const directory = await openOrdinaryStateDirectory(stateDirectory);
  const opened: OpenedNamedFile[] = [];
  try {
    const beforeEntries = await readdir(stateDirectory);
    assertSameEntries(expectedEntries, beforeEntries);
    for (const name of beforeEntries.toSorted()) {
      opened.push({
        name,
        stateFile: await openOrdinaryStateFile(
          join(stateDirectory, name),
          name === markerName ? 0o444 : 0o600,
          name === markerName ? "ordinary CI bundle state marker" : "ordinary CI database state"
        )
      });
    }
    const marker = opened.find(({ name }) => name === markerName);
    if (marker === undefined) throw new UserError("ordinary CI bundle state marker is missing");
    const markerJson = await marker.stateFile.handle.readFile("utf8");
    for (const source of opened.filter(({ name }) => name === databaseName || name === `${databaseName}-wal`)) {
      await pipeline(
        source.stateFile.handle.createReadStream({ autoClose: false }),
        createWriteStream(join(copyDirectory, source.name), { flags: "wx", mode: 0o600 })
      );
    }
    await assertSnapshotUnchanged(stateDirectory, directory, opened, beforeEntries);
    return markerJson;
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new SnapshotChangedError();
    throw error;
  } finally {
    await Promise.all(opened.map(async ({ stateFile }) => stateFile.handle.close()));
    await directory.handle.close();
  }
}

async function assertSnapshotUnchanged(
  stateDirectory: string,
  directory: OpenedStateFile,
  opened: readonly OpenedNamedFile[],
  beforeEntries: readonly string[]
): Promise<void> {
  const afterEntries = await readdir(stateDirectory);
  assertSameEntries(beforeEntries, afterEntries);
  const directoryAfter = await directory.handle.stat({ bigint: true });
  const reopenedDirectory = await openOrdinaryStateDirectory(stateDirectory);
  try {
    if (metadataChanged(directory.metadata, directoryAfter)
      || metadataChanged(directory.metadata, reopenedDirectory.metadata)) {
      throw new SnapshotChangedError();
    }
  } finally {
    await reopenedDirectory.handle.close();
  }
  const changed = await Promise.all(opened.map(async ({ stateFile }) =>
    metadataChanged(stateFile.metadata, await stateFile.handle.stat({ bigint: true }))));
  if (changed.some(Boolean)) throw new SnapshotChangedError();
}

function assertSameEntries(expected: readonly string[], actual: readonly string[]): void {
  const expectedSorted = expected.toSorted();
  const actualSorted = actual.toSorted();
  if (expectedSorted.length !== actualSorted.length
    || expectedSorted.some((entry, index) => entry !== actualSorted[index])) {
    throw new SnapshotChangedError();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
