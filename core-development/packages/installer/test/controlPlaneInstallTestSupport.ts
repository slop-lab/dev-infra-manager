import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { readControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import { writeControlPlaneFixture, writePrivate } from "./controlPlaneFixture.js";
import type { FirstInstallRunner } from "./controlPlaneInstallFixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

export class ObservingReadiness {
  constructor(
    stateRoot: string,
    readonly runner: FirstInstallRunner,
    failReadiness = false,
    failOnEvent?: "ready:native" | "ready:ordinary",
    expectInstalled = false
  ) {
    runner.readinessStateRoot = stateRoot;
    runner.failEveryReadiness = failReadiness;
    runner.failReadinessEvent = failOnEvent;
    runner.readinessExpectedInstalled = expectInstalled;
  }

  get events(): string[] { return this.runner.readinessEvents; }
  get generationDigestAtFailure(): string | undefined { return this.runner.readinessGenerationDigestAtFailure; }
  set expectInstalled(value: boolean) { this.runner.readinessExpectedInstalled = value; }
}

export async function installFixture(): Promise<{ readonly configPath: string; readonly stateRoot: string }> {
  const directory = await mkdtemp(join(tmpdir(), "dim-control-plane-install-"));
  temporaryDirectories.push(directory);
  const source = await writeControlPlaneFixture(join(directory, "operator"));
  return { configPath: source.configPath, stateRoot: join(directory, "state") };
}

export function deterministicRandom(): (size: number) => Buffer {
  let fill = 20;
  return (size) => Buffer.alloc(size, fill++);
}

export const immediateReadinessDeadline = {
  timeoutMilliseconds: 1,
  retryIntervalMilliseconds: 1,
  execTimeoutMilliseconds: 1
} as const;

export async function writeChangedImages(configPath: string): Promise<void> {
  const config = await readControlPlaneConfig(configPath, ["127.0.0.1"]);
  await writePrivate(configPath, `${JSON.stringify({
    ...config,
    nativeGit: { ...config.nativeGit, image: `registry.example/dim/native-git@sha256:${"c".repeat(64)}` },
    ordinaryCi: { ...config.ordinaryCi, image: `registry.example/dim/ordinary-ci@sha256:${"d".repeat(64)}` }
  })}\n`);
}

export async function writeChangedPorts(configPath: string, changeImages = false): Promise<void> {
  const config = await readControlPlaneConfig(configPath, ["127.0.0.1"]);
  await writePrivate(configPath, `${JSON.stringify({
    ...config,
    nativeGit: {
      ...config.nativeGit,
      ...(changeImages ? { image: `registry.example/dim/native-git@sha256:${"c".repeat(64)}` } : {}),
      publish: { ...config.nativeGit.publish, port: 7543 }
    },
    ordinaryCi: {
      ...config.ordinaryCi,
      ...(changeImages ? { image: `registry.example/dim/ordinary-ci@sha256:${"d".repeat(64)}` } : {}),
      publish: { ...config.ordinaryCi.publish, port: 7510 }
    }
  })}\n`);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function directoryDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of (await readdir(path)).sort()) hash.update(name).update(await readFile(join(path, name)));
  return hash.digest("hex");
}
