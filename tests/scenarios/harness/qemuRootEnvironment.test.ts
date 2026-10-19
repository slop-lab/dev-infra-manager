import { describe, expect, it } from "vitest";
import { http, spawnRecords, startService, waitForObservation } from "./qemuServiceTestSupport.js";

describe("QEMU root environment", () => {
  it("keeps launcher children rooted at the assembled source tree", async () => {
    const service = await startService("exit");

    const response = await http(service, { body: { mode: "run" }, method: "POST", path: "/v1/run" });
    const launcher = await waitForObservation(async () =>
      (await spawnRecords(service)).find((record) => record.command === "bash"));

    expect.soft(response.status).toBe(202);
    expect(launcher).toMatchObject({ cwd: service.sourceRoot, sourceRoot: service.sourceRoot });
  });
});