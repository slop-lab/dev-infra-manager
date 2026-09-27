import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, rename, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  http,
  launchRecords,
  readEvents,
  spawnRecords,
  startService
} from "./qemuServiceTestSupport.js";

const fixtureServers: Server[] = [];

afterEach(async () => {
  await Promise.all(fixtureServers.splice(0).map(async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    }));
  }));
});

describe("QEMU service snapshots", () => {
  it("passes immutable service-owned snapshots without dereferencing symlinks", async () => {
    // Given
    const fixture = await startService("hold");
    const input = resolve(fixture.sourceRoot, "input");
    await mkdir(input);
    await writeFile(resolve(input, "payload.txt"), "admitted\n");
    await symlink("payload.txt", resolve(input, "link"));

    // When
    const started = await http(fixture, {
      body: { inputs: [{ name: "fixture", path: input }] }, method: "POST", path: "/v1/run"
    });
    await readEvents(fixture, "ready\n");
    const records = await launchRecords(fixture);
    const passed = records[0]?.[0];
    if (passed === undefined) throw new TypeError("launcher did not receive an input");
    const moved = resolve(fixture.sourceRoot, "input-before-replacement");
    const replacement = resolve(fixture.sourceRoot, "replacement");
    await rename(input, moved);
    await mkdir(replacement);
    await writeFile(resolve(replacement, "payload.txt"), "replaced\n");
    await writeFile(resolve(replacement, "link"), "not-a-symlink\n");
    await symlink(replacement, input, "dir");
    const content = await readFile(resolve(passed.path, "payload.txt"), "utf8");
    const storageMode = (await lstat(resolve(passed.path, "../.."))).mode & 0o777;
    const link = await lstat(resolve(passed.path, "link"));
    const linkTarget = link.isSymbolicLink() ? await readlink(resolve(passed.path, "link")) : null;
    const cancelled = await http(fixture, { method: "DELETE", path: "/v1/run" });
    await readEvents(fixture);

    // Then
    expect.soft(started.status).toBe(202);
    expect.soft({ owned: passed.path.startsWith(`${fixture.runsRoot}/`), mode: storageMode })
      .toEqual({ owned: true, mode: 0o700 });
    expect.soft(content).toBe("admitted\n");
    expect.soft({ symbolic: link.isSymbolicLink(), target: linkTarget })
      .toEqual({ symbolic: true, target: "payload.txt" });
    expect(cancelled.status).toBe(202);
  });

  it("uses no subprocess when rejecting an unsupported snapshot and releases the admission claim", async () => {
    // Given
    const fixture = await startService("exit");
    const unsupported = resolve(fixture.sourceRoot, "unsupported");
    const valid = resolve(fixture.sourceRoot, "valid");
    await mkdir(unsupported);
    await mkdir(valid);
    const special = createServer();
    fixtureServers.push(special);
    await new Promise<void>((resolveListen, rejectListen) => {
      special.once("error", rejectListen);
      special.listen(resolve(unsupported, "entry.sock"), resolveListen);
    });

    // When
    const rejected = await http(fixture, {
      body: { inputs: [{ name: "unsupported", path: unsupported }] }, method: "POST", path: "/v1/run"
    });
    const rejectedSpawns = await spawnRecords(fixture);
    await new Promise<void>((resolveClose, rejectClose) => special.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    }));
    const accepted = await http(fixture, {
      body: { inputs: [{ name: "valid", path: valid }] }, method: "POST", path: "/v1/run"
    });
    if (accepted.status === 202) await readEvents(fixture);

    // Then
    expect.soft(rejected.status).toBe(400);
    expect.soft(rejectedSpawns, "unsupported snapshot admission must remain in-process").toEqual([]);
    expect.soft(accepted.status).toBe(202);
    expect(await launchRecords(fixture)).toHaveLength(1);
  });

  it("copies nested regular files while preserving executable permission bits", async () => {
    // Given
    const fixture = await startService("hold");
    const input = resolve(fixture.sourceRoot, "nested-input");
    const nested = resolve(input, "bin");
    const executable = resolve(nested, "verify");
    await mkdir(nested, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o751);

    // When
    const started = await http(fixture, {
      body: { inputs: [{ name: "nested", path: input }] }, method: "POST", path: "/v1/run"
    });
    await readEvents(fixture, "ready\n");
    const passed = (await launchRecords(fixture))[0]?.[0];
    if (passed === undefined) throw new TypeError("launcher did not receive the nested input");
    const copied = resolve(passed.path, "bin/verify");
    const copiedBytes = await readFile(copied, "utf8");
    const copiedMode = (await lstat(copied)).mode & 0o777;
    const cancelled = await http(fixture, { method: "DELETE", path: "/v1/run" });
    await readEvents(fixture);

    // Then
    expect.soft(started.status).toBe(202);
    expect.soft(copiedBytes).toBe("#!/bin/sh\nexit 0\n");
    expect.soft(copiedMode).toBe(0o751);
    expect(cancelled.status).toBe(202);
  });

  it("streams nested multi-entry directories without using readdir", async () => {
    // Given
    const fixture = await startService("hold", { rejectReaddir: true });
    const input = resolve(fixture.sourceRoot, "streamed-input");
    const nested = resolve(input, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(resolve(input, "root.txt"), "root\n");
    await writeFile(resolve(nested, "first.txt"), "first\n");
    await writeFile(resolve(nested, "second.txt"), "second\n");

    // When
    const started = await http(fixture, {
      body: { inputs: [{ name: "streamed", path: input }] }, method: "POST", path: "/v1/run"
    });
    if (started.status !== 202) throw new TypeError(`snapshot admission failed: ${started.body}`);
    await readEvents(fixture, "ready\n");
    const passed = (await launchRecords(fixture))[0]?.[0];
    if (passed === undefined) throw new TypeError("launcher did not receive the streamed input");
    const copied = await Promise.all([
      readFile(resolve(passed.path, "root.txt"), "utf8"),
      readFile(resolve(passed.path, "nested/first.txt"), "utf8"),
      readFile(resolve(passed.path, "nested/second.txt"), "utf8")
    ]);
    const cancelled = await http(fixture, { method: "DELETE", path: "/v1/run" });
    await readEvents(fixture);

    // Then
    expect.soft(copied).toEqual(["root\n", "first\n", "second\n"]);
    expect(cancelled.status).toBe(202);
  });

  it("rejects a FIFO without starting a snapshot or launcher subprocess", async () => {
    // Given
    const fixture = await startService("exit");
    const input = resolve(fixture.sourceRoot, "fifo-input");
    const fifo = resolve(input, "stream");
    await mkdir(input);
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (created.status !== 0) throw new TypeError(`mkfifo failed: ${created.stderr}`);

    // When
    const rejected = await http(fixture, {
      body: { inputs: [{ name: "fifo", path: input }] }, method: "POST", path: "/v1/run"
    });

    // Then
    expect.soft(rejected.status).toBe(400);
    expect.soft(await spawnRecords(fixture)).toEqual([]);
    expect(await launchRecords(fixture)).toEqual([]);
  });
});
