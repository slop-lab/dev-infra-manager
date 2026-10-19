import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { http, readEvents, startService, waitForObservation } from "./qemuServiceTestSupport.js";

describe("QEMU launcher spawn failure", () => {
  it("finalizes an asynchronous ENOENT and admits the next request", async () => {
    const fixture = await startService("exit", { missingLauncherShell: true });

    const first = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    const firstTerminal = await waitForObservation(async () => {
      const status = await http(fixture, { method: "GET", path: "/v1/status" });
      const value: unknown = JSON.parse(status.body);
      return typeof value === "object" && value !== null && "status" in value && value.status === "failure" ? value : undefined;
    });
    const firstEvents = await readEvents(fixture);

    const second = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture);

    expect.soft(first.status).toBe(202);
    expect.soft(firstTerminal).toMatchObject({ status: "failure" });
    expect.soft(firstEvents).toContain("spawn bash ENOENT");
    expect.soft(second.status).toBe(202);
    expect(await readdir(fixture.runsRoot)).toEqual([]);
  });
});
