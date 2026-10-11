import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStorageOwner, inspectStorageOwner } from "../../../../core/packages/native-git/src/storage-owner.js";

const run = promisify(execFile);
const roots: string[] = [];
const containers: string[] = [];
const volumes: string[] = [];
const images: string[] = [];
const image = process.env.DIM_NATIVE_GIT_TEST_IMAGE;
const workspace = resolve(import.meta.dirname, "../../../..");

type OwnerContainer = Readonly<{ name: string; volume: string; image: string }>;

afterEach(async () => {
  await Promise.all(containers.splice(0).map(async (container) => {
    await run("docker", ["rm", "--force", container]).catch((error: unknown) => {
      if (!(error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        && error.stderr.includes("No such container"))) throw error;
    });
  }));
  await Promise.all(volumes.splice(0).map((volume) => run("docker", ["volume", "rm", "--force", volume])));
  await Promise.all(images.splice(0).map((builtImage) => run("docker", ["image", "rm", "--force", builtImage])));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DIM native Git storage ownership state", () => {
  it("rejects a symbolic-link owner database without changing its target", async () => {
    // Given
    const root = await temporaryRoot();
    const foreign = join(await temporaryRoot(), "foreign");
    await writeFile(foreign, "foreign\n");
    await symlink(foreign, join(root, ".dim-native-git-owner.sqlite3"));

    // When / Then
    await expect(acquireStorageOwner(root)).rejects.toThrow(/symbolic link/i);
    await expect(readFile(foreign, "utf8")).resolves.toBe("foreign\n");
  });

  it("rejects a storage root reached through a symbolic link without creating owner state", async () => {
    // Given
    const root = await temporaryRoot();
    const link = join(await temporaryRoot(), "storage-link");
    await symlink(root, link);

    // When / Then
    await expect(acquireStorageOwner(link)).rejects.toThrow(/canonical non-symbolic-link path/i);
    await expect(access(join(root, ".dim-native-git-owner.sqlite3"))).rejects.toThrow();
  });

  it("rejects an owner database copied from a different storage root", async () => {
    // Given
    const firstRoot = await temporaryRoot();
    const firstOwner = await acquireStorageOwner(firstRoot);
    await firstOwner.release();
    const secondRoot = await temporaryRoot();
    await copyFile(
      join(firstRoot, ".dim-native-git-owner.sqlite3"),
      join(secondRoot, ".dim-native-git-owner.sqlite3"),
      0
    );

    // When / Then
    await expect(acquireStorageOwner(secondRoot)).rejects.toThrow(/different storage root/i);
  });

  it("releases the process reservation after owner-state validation fails", async () => {
    // Given
    const root = await temporaryRoot();
    const database = join(root, ".dim-native-git-owner.sqlite3");
    const foreign = join(await temporaryRoot(), "foreign");
    await writeFile(foreign, "foreign\n");
    await symlink(foreign, database);
    await expect(acquireStorageOwner(root)).rejects.toThrow(/symbolic link/i);
    await rm(database);

    // When
    const owner = await acquireStorageOwner(root);

    // Then
    await expect(owner.release()).resolves.toBeUndefined();
  });

  it("inspects owner identity while the service holds its exclusive ownership lock", async () => {
    // Given: a live service holds the storage owner's cross-process SQLite lock.
    const root = await temporaryRoot();
    const owner = await acquireStorageOwner(root);

    // When / Then: read-only state inspection validates identity without competing for that lock.
    await expect(inspectStorageOwner(root)).resolves.toBeUndefined();
    await owner.release();
  });
});

describe.runIf(image !== undefined)("DIM native Git storage ownership isolation", () => {
  it("rejects an owner in another network namespace and recovers after owner crash", async () => {
    // Given
    const testImage = await buildTestImage();
    const volume = `dim-native-git-owner-${randomUUID()}`;
    volumes.push(volume);
    await run("docker", ["volume", "create", volume]);
    await run("docker", ["run", "--rm", "--volume", `${volume}:/storage`, testImage, "chmod", "700", "/storage"]);
    const firstName = `dim-native-git-owner-${randomUUID()}`;
    containers.push(firstName);
    const first = startOwner({ name: firstName, volume, image: testImage });
    await expect(nextLines(first, 2)).resolves.toEqual(["FIRST_ACQUIRED", "SECOND_DENIED"]);

    // When
    const collisionContainer = { name: `dim-native-git-owner-${randomUUID()}`, volume, image: testImage };
    const collision = await runOwner(collisionContainer, "collision-marker");

    // Then
    expect(collision.exitCode).toBe(23);
    expect(collision.stdout).not.toContain("listening");
    expect(collision.stderr).toMatch(/storage root.*active server/i);
    await expect(run("docker", [
      "run", "--rm", "--volume", `${volume}:/storage`, "--entrypoint", "test", testImage,
      "!", "-e", "/storage/collision-marker"
    ])).resolves.toBeDefined();

    // When
    await run("docker", ["kill", "--signal", "KILL", firstName]);
    await exited(first);
    const recovered = await runOwner({ name: `dim-native-git-owner-${randomUUID()}`, volume, image: testImage });

    // Then
    expect(recovered).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("listening") });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-git-owner-state-"));
  roots.push(root);
  return root;
}

function startOwner(container: OwnerContainer): ChildProcessWithoutNullStreams {
  return spawn("docker", containerArguments(container, ownerScript), { stdio: "pipe" });
}

async function runOwner(container: OwnerContainer, marker?: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await run("docker", containerArguments(container, oneShotOwnerScript(marker)));
    return { exitCode: 0, ...result };
  } catch (error) {
    if (isExitError(error)) return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    throw error;
  }
}

function containerArguments(container: OwnerContainer, script: string): readonly string[] {
  return [
    "run", "--rm", "--name", container.name, "--network", "none",
    "--volume", `${container.volume}:/storage`,
    "--volume", `${container.volume}:/storage-alias`,
    container.image,
    "node", "--experimental-strip-types", "--input-type=module", "--eval", script
  ];
}

async function buildTestImage(): Promise<string> {
  if (image === undefined) throw new Error("DIM_NATIVE_GIT_TEST_IMAGE is required");
  const context = await mkdtemp(join(tmpdir(), "dim-native-git-owner-image-"));
  roots.push(context);
  await copyFile(join(workspace, "core", "packages", "native-git", "src", "storage-owner.ts"), join(context, "storage-owner.ts"));
  await writeFile(join(context, "Dockerfile"), "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY storage-owner.ts /app/storage-owner.ts\n");
  const testImage = `dim-native-git-owner-test:${randomUUID()}`;
  images.push(testImage);
  await run("docker", ["build", "--quiet", "--build-arg", `BASE_IMAGE=${image}`, "--tag", testImage, context]);
  return testImage;
}

async function nextLines(child: ChildProcessWithoutNullStreams, count: number): Promise<readonly string[]> {
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolveLines, reject) => {
    const received: string[] = [];
    const timeout = setTimeout(() => reject(new Error("owner process did not become ready")), 10_000);
    lines.on("line", (line) => {
      received.push(line);
      if (received.length === count) {
        clearTimeout(timeout);
        lines.close();
        resolveLines(received);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`owner process exited before readiness with code ${String(code)}`));
    });
  });
}

async function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

function oneShotOwnerScript(marker: string | undefined): string {
  const mutation = marker === undefined
    ? ""
    : `await writeFile(join(root, ${JSON.stringify(marker)}), "mutated\\n");`;
  return `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireStorageOwner } from "/app/storage-owner.ts";
const root = "/storage";
try {
  const owner = await acquireStorageOwner(root);
  ${mutation}
  console.log("listening");
  await owner.release();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 23;
}`;
}

const ownerScript = `import { acquireStorageOwner } from "/app/storage-owner.ts";
const owner = await acquireStorageOwner("/storage");
console.log("FIRST_ACQUIRED");
try {
  const duplicate = await acquireStorageOwner("/storage-alias");
  console.log("SECOND_ACQUIRED");
  await duplicate.release();
} catch (error) {
  if (!(error instanceof Error) || !/storage root.*active server/i.test(error.message)) throw error;
  console.log("SECOND_DENIED");
}
const keepAlive = setInterval(() => {}, 60_000);
process.once("SIGTERM", async () => { clearInterval(keepAlive); await owner.release(); });`;

function isExitError(error: unknown): error is Error & {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  return error instanceof Error && "code" in error && typeof error.code === "number"
    && "stdout" in error && typeof error.stdout === "string"
    && "stderr" in error && typeof error.stderr === "string";
}
