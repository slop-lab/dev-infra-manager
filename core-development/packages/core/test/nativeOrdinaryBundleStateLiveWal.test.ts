import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeNativeOrdinaryBundleState,
  inspectNativeOrdinaryBundleState
} from "../../../../core/packages/core/src/nativeOrdinaryBundleState.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const writerFixture = join(import.meta.dirname, "fixtures/nativeOrdinaryWalWriter.mjs");

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopWriter));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary bundle state live WAL inspection", () => {
  it("accepts only coherent snapshots or rejects bounded instability across 100 probes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-live-wal-"));
    await chmod(root, 0o750);
    roots.push(root);
    const state = await initializeNativeOrdinaryBundleState(root);
    const setup = new DatabaseSync(state.database);
    setup.prepare("INSERT INTO bundle_activation VALUES (?, ?)").run("a".repeat(64), "b".repeat(64));
    setup.close();
    const writer = spawn(process.execPath, [writerFixture, state.database], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(writer);
    await writerReady(writer);
    const businessState = activationRows(state.database);

    // When
    const outcomes: ProbeOutcome[] = [];
    for (let iteration = 0; iteration < 100; iteration += 1) {
      try {
        outcomes.push({ kind: "accepted", stateFormat: (await inspectNativeOrdinaryBundleState(root)).stateFormat });
      } catch (error) {
        outcomes.push({ kind: "rejected", error });
      }
    }
    const transactions = await stopWriter(writer);

    // Then
    expect(outcomes).toHaveLength(100);
    expect(outcomes.every((outcome) => {
      switch (outcome.kind) {
        case "accepted":
          return outcome.stateFormat === 5;
        case "rejected":
          return outcome.error instanceof Error
            && /state changed while it was inspected/i.test(outcome.error.message);
        default: {
          const unreachable: never = outcome;
          throw new TypeError(`unexpected probe outcome: ${String(unreachable)}`);
        }
      }
    })).toBe(true);
    expect(transactions).toBeGreaterThan(100);
    expect(activationRows(state.database)).toEqual(businessState);
  }, 30_000);
});

type ProbeOutcome =
  | { readonly kind: "accepted"; readonly stateFormat: 5 }
  | { readonly kind: "rejected"; readonly error: unknown };

async function writerReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) throw new TypeError("WAL writer pipes are unavailable");
  let errors = "";
  stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    stdout.setEncoding("utf8").once("data", (chunk: string) => {
      if (chunk.startsWith("ready\n")) resolveReady();
      else rejectReady(new Error(`WAL writer emitted unexpected output: ${chunk}`));
    });
    child.once("exit", (code) => rejectReady(new Error(`WAL writer exited ${String(code)}: ${errors}`)));
    child.once("error", rejectReady);
  });
}

async function stopWriter(child: ChildProcess): Promise<number> {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  if (child.exitCode !== null || child.signalCode !== null) return 0;
  const stdout = child.stdout;
  if (stdout === null) throw new TypeError("WAL writer stdout is unavailable");
  let output = "";
  stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const exit = new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`WAL writer exited ${String(code)}`)));
    child.once("error", rejectExit);
  });
  child.kill("SIGTERM");
  await exit;
  const finalLine = output.trim().split("\n").at(-1);
  const parsed: unknown = finalLine === undefined ? undefined : JSON.parse(finalLine);
  const transactions = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "transactions") : undefined;
  if (typeof transactions !== "number") throw new TypeError("WAL writer omitted its transaction count");
  return transactions;
}

function activationRows(databasePath: string): readonly unknown[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT generation_id FROM bundle_activation ORDER BY generation_id").all();
  } finally {
    database.close();
  }
}
