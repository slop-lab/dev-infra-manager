import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configuredExecutionServer } from "../../../../../core/packages/managed/src/ci/service.js";
import { ExecutionStore } from "../../../../../core/packages/managed/src/ci/store.js";
import { executionServiceConfigSchema } from "../../../../../core/packages/managed/src/ci/config.js";
import { idleOrdinaryConfig } from "../../../native-git/test/bundleConfigFixture.js";
import { event, generation, grant, result, slot } from "./executionFixture.js";

it("stops publishing queued evidence on shutdown and leaves it durable for restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-ci-shutdown-"));
  const store = new ExecutionStore(join(directory, "executions.sqlite3"), generation, 60_000);
  for (const name of ["first", "second"]) {
    store.enqueue(event(name));
    const assignment = store.reserve("worker-a", slot, randomUUID())!;
    const authorized = store.attachGrant(assignment.id, grant(assignment));
    store.finish(assignment.id, "worker-a", slot.id, assignment.leaseToken, result(authorized.grant!));
  }
  store.close();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let publications = 0;
  const ci = configuredExecutionServer({ config: executionServiceConfigSchema.parse(idleOrdinaryConfig()),
    stateDirectory: directory, expectedGenerationId: generation, readinessToken: "ready", activationToken: "activate",
    source: {
      async authorize() { throw new Error("unexpected grant request"); },
      async candidate() { throw new Error("unexpected candidate request"); },
      async publish() { publications++; await blocked; throw new Error("Git unavailable"); }
    } });
  try {
    expect(publications).toBe(1);
    const closing = ci.close();
    release();
    await closing;
    expect(publications).toBe(1);
    const reopened = new ExecutionStore(join(directory, "executions.sqlite3"), generation, 60_000);
    try { expect(reopened.pendingResults()).toHaveLength(2); } finally { reopened.close(); }
  } finally { release(); await ci.close(); await rm(directory, { recursive: true, force: true }); }
});
