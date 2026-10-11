import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeOrdinaryAttemptStore,
  ordinaryAttemptStorePaths
} from "../../../../core/packages/native-git/src/authoritative-ordinary-attempt-files.js";
import { assertAuthoritativeOrdinaryAttemptStore } from "../../../../core/packages/native-git/src/authoritative-ordinary-attempt-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store() {
  const repository = await mkdtemp(join(tmpdir(), "dim-native-attempt-safety-"));
  roots.push(repository);
  const paths = ordinaryAttemptStorePaths(repository);
  await initializeOrdinaryAttemptStore(paths);
  return { repository, paths };
}

describe("installed ordinary attempt storage safety", () => {
  it("preserves a wrong-mode unpublished staging file instead of deleting it", async () => {
    // Given
    const { repository, paths } = await store();
    const job = join(paths.issuances, "a".repeat(64), "source");
    await mkdir(job, { recursive: true, mode: 0o700 });
    const staging = join(job, ".1.json.00000000-0000-4000-8000-000000000001.tmp");
    await writeFile(staging, "foreign evidence\n", { mode: 0o600 });
    await chmod(staging, 0o640);
    const before = await readFile(staging);

    // When / Then
    await expect(assertAuthoritativeOrdinaryAttemptStore(repository)).rejects.toThrow();
    expect(await readFile(staging)).toEqual(before);
    expect((await stat(staging)).mode & 0o777).toBe(0o640);
  });

  it("preserves an unpublished hard link to a foreign file", async () => {
    // Given
    const { repository, paths } = await store();
    const job = join(paths.issuances, "a".repeat(64), "source");
    await mkdir(job, { recursive: true, mode: 0o700 });
    const foreign = join(repository, "foreign.json");
    await writeFile(foreign, "keep\n", { mode: 0o600 });
    const staging = join(job, ".1.json.00000000-0000-4000-8000-000000000001.tmp");
    await link(foreign, staging);

    // When / Then
    await expect(assertAuthoritativeOrdinaryAttemptStore(repository)).rejects.toThrow();
    expect(await readFile(staging)).toEqual(Buffer.from("keep\n"));
    expect((await stat(foreign)).nlink).toBe(2);
  });

  it("refuses an existing overpermissive store directory without repairing it", async () => {
    // Given
    const { paths } = await store();
    await chmod(paths.kind, 0o755);

    // When / Then
    await expect(initializeOrdinaryAttemptStore(paths)).rejects.toThrow();
    expect((await stat(paths.kind)).mode & 0o777).toBe(0o755);
  });
});
