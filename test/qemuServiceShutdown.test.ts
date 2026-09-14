import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  http,
  incompleteRun,
  launchRecords,
  readEvents,
  spawnRecords,
  startService,
  waitForExit,
  waitForObservation,
  type ServiceFixture
} from "./qemuServiceTestSupport.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function survivingArtifacts(fixture: ServiceFixture): Promise<readonly string[]> {
  const paths = [fixture.runsRoot, fixture.socketPath, resolve(fixture.root, "service-owner.json")];
  const observations = await Promise.all(paths.map(async (path) => {
    try {
      await lstat(path);
      return path;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }));
  return observations.filter((path) => path !== undefined);
}

describe("QEMU service shutdown", () => {
  it("preserves replaced owner and socket inodes during service shutdown", async () => {
    const fixture = await startService("hold");
    const ownerPath = resolve(fixture.root, "service-owner.json");
    await rm(fixture.socketPath);
    const replacementSocket = createServer();
    await new Promise<void>((resolveListen) => replacementSocket.listen(fixture.socketPath, resolveListen));
    const replacementOwner = resolve(fixture.root, "replacement-owner.json");
    await writeFile(replacementOwner, "replacement-owner\n");
    await rename(replacementOwner, ownerPath);

    fixture.process.kill("SIGTERM");
    await waitForExit(fixture, 2_000);

    expect.soft((await lstat(fixture.socketPath)).isSocket()).toBe(true);
    expect(await readFile(ownerPath, "utf8")).toBe("replacement-owner\n");
    await new Promise<void>((resolveClose) => replacementSocket.close(() => resolveClose()));
  });

  it("drains an admitted incomplete body before bounded exit without launching or retaining artifacts", async () => {
    // Given
    const fixture = await startService("hold");
    const run = incompleteRun(fixture);
    const responseSettled = run.response.then(() => undefined, () => undefined);
    await run.continued;

    // When
    fixture.process.kill("SIGTERM");
    const exitedWhileIncomplete = await waitForExit(fixture);
    run.abort();
    await responseSettled;
    if (!exitedWhileIncomplete) await waitForExit(fixture);

    // Then
    expect.soft(exitedWhileIncomplete, "SIGTERM must close an incomplete admitted request").toBe(true);
    expect.soft(await spawnRecords(fixture)).toEqual([]);
    expect.soft(await launchRecords(fixture)).toEqual([]);
    expect(await survivingArtifacts(fixture)).toEqual([]);
  });

  it("cancels an observed partial snapshot before exit without launching or retaining artifacts", async () => {
    // Given
    const fixture = await startService("hold");
    const input = resolve(fixture.sourceRoot, "large-input");
    const fileCount = 512;
    const payload = Buffer.alloc(8 * 1024, 0x61);
    await mkdir(input);
    await Promise.all(Array.from({ length: fileCount }, (_value, index) =>
      writeFile(resolve(input, `${String(index).padStart(4, "0")}.data`), payload)
    ));

    // When
    const run = http(fixture, {
      body: { inputs: [{ name: "large", path: input }] }, method: "POST", path: "/v1/run"
    });
    const runSettled = run.then(() => undefined, () => undefined);
    const partialDestination = await waitForObservation(async () => {
      try {
        const runNames = await readdir(fixture.runsRoot);
        const runName = runNames[0];
        if (runName === undefined) return undefined;
        const destination = resolve(fixture.runsRoot, runName, "inputs/large");
        const copied = await readdir(destination);
        return copied.length > 0 && copied.length < fileCount ? destination : undefined;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    });
    const copiedBeforeSignal = await readdir(partialDestination);
    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 2_000);
    await runSettled;

    // Then
    expect.soft(copiedBeforeSignal.length).toBeGreaterThan(0);
    expect.soft(copiedBeforeSignal.length).toBeLessThan(fileCount);
    expect.soft(exited, "SIGTERM must bound active snapshot shutdown").toBe(true);
    expect.soft((await spawnRecords(fixture)).filter((record) => record.command === "bash")).toEqual([]);
    expect.soft(await launchRecords(fixture)).toEqual([]);
    expect(await survivingArtifacts(fixture)).toEqual([]);
  }, 10_000);

  it("waits for a launched detached child to close and cleans ownership artifacts before exit", async () => {
    // Given
    const fixture = await startService("hold");
    const input = resolve(fixture.sourceRoot, "input");
    await mkdir(input);
    await writeFile(resolve(input, "payload"), "fixture\n");
    const started = await http(fixture, {
      body: { inputs: [{ name: "fixture", path: input }] }, method: "POST", path: "/v1/run"
    });
    await readEvents(fixture, "ready\n");

    // When
    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 5_000);
    const launcherStopped = await readFile(fixture.launcherStopFile, "utf8");

    // Then
    expect.soft(started.status).toBe(202);
    expect.soft(exited, "service exit must follow detached launcher close").toBe(true);
    expect.soft(launcherStopped).toBe("stopped");
    expect(await survivingArtifacts(fixture)).toEqual([]);
  });
});
