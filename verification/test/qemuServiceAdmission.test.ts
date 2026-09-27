import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  http,
  incompleteRun,
  launchRecords,
  readEvents,
  startService
} from "./qemuServiceTestSupport.js";

describe("QEMU service admission", () => {
  it("claims an incomplete request synchronously so a later request cannot become another run owner", async () => {
    // Given
    const fixture = await startService("exit");
    const firstRun = incompleteRun(fixture);
    await firstRun.continued;

    // When
    const later = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    if (later.status === 202) await readEvents(fixture);
    firstRun.finish();
    const first = await firstRun.response;
    if (first.status === 202) await readEvents(fixture);
    const records = await launchRecords(fixture);

    // Then
    expect.soft(later.status).toBe(409);
    expect.soft(first.status).toBe(202);
    expect(records).toHaveLength(1);
  });

  it("rejects duplicate names before resolving paths and releases the admission claim", async () => {
    // Given
    const fixture = await startService("exit");
    const valid = resolve(fixture.sourceRoot, "valid");
    await mkdir(valid);

    // When
    const rejected = await http(fixture, { body: { inputs: [
      { name: "duplicate", path: resolve(fixture.sourceRoot, "missing") },
      { name: "duplicate", path: valid }
    ] }, method: "POST", path: "/v1/run" });
    const accepted = await http(fixture, {
      body: { inputs: [{ name: "valid", path: valid }] }, method: "POST", path: "/v1/run"
    });
    if (accepted.status === 202) await readEvents(fixture);

    // Then
    expect.soft(rejected.status).toBe(400);
    expect.soft(rejected.body).toContain("duplicate input name");
    expect.soft(accepted.status).toBe(202);
    expect(await launchRecords(fixture)).toHaveLength(1);
  });
});
