import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CommandFailure } from "../../web-lifecycle/process.ts";
import { readPracticalProgress } from "../progress.ts";
import { incusPreparationLabels, timeIncusPreparation } from "./preparationTiming.ts";

it("emits fixed start/finish timing while returning the operation's actual value", async () => {
  const lines: string[] = [], value = {};
  expect(await timeIncusPreparation("incus-publish", async () => value, line => { lines.push(line); })).toBe(value);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\[examples-timing\] incus-publish start utc=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
  expect(lines[1]).toMatch(/^\[examples-timing\] incus-publish finish utc=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ elapsedSeconds=[0-9]+ exit=0\n$/);
});

it.each([false, true])("retains the same command error and exit23 when the timing writer throws=%s", async brokenWriter => {
  const lines: string[] = [], failure = new CommandFailure("private-command", ["private-argument"], { exitCode: 23, stdout: "PRIVATE", stderr: "PRIVATE" });
  await expect(timeIncusPreparation("incus-cloud-init", async () => { throw failure; }, line => {
    lines.push(line); if (brokenWriter) throw new Error("writer failed");
  })).rejects.toBe(failure);
  expect(lines[1]).toMatch(/ elapsedSeconds=[0-9]+ exit=23\n$/);
  expect(lines.join("")).not.toContain("PRIVATE"); expect(lines.join("")).not.toContain("private-command");
});

it("preserves success with a broken writer and preserves unclassified errors with exit1", async () => {
  const write = () => { throw new Error("writer failed"); };
  expect(await timeIncusPreparation("incus-stop", async () => 17, write)).toBe(17);
  const failure = new Error("private failure"), lines: string[] = [];
  await expect(timeIncusPreparation("incus-node", async () => { throw failure; }, line => { lines.push(line); })).rejects.toBe(failure);
  expect(lines[1]).toMatch(/ exit=1\n$/); expect(lines.join("")).not.toContain(failure.message);
});

it("forwards every actual fixed Incus span and excludes unknown labels and private raw output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-incus-timing-")), log = join(directory, "prepare.log"), lines: string[] = [];
  try {
    for (const label of incusPreparationLabels) await timeIncusPreparation(label, async () => {}, line => { lines.push(line); });
    await writeFile(log, "PRIVATE_RAW_OUTPUT\n" + lines.join("") + "[examples-timing] incus-private-arbitrary start utc=2026-11-08T16:00:00Z\n", { mode: 0o600 });
    expect(readPracticalProgress(log, 0).lines).toEqual(lines.map(line => line.trimEnd()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
