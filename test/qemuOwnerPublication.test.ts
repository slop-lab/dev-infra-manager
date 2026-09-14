import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startService } from "./qemuServiceTestSupport.js";

describe("QEMU structured service ownership", () => {
  it("atomically publishes a mode-0600 schema-1 owner record instead of service.pid", async () => {
    const fixture = await startService("exit");
    const ownerPath = resolve(fixture.root, "service-owner.json");

    const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    const mode = (await lstat(ownerPath)).mode & 0o777;

    expect.soft(mode).toBe(0o600);
    expect.soft(owner).toMatchObject({ schema: 1, pid: String(fixture.process.pid) });
    await expect(readFile(resolve(fixture.root, "service.pid"), "utf8")).rejects.toThrow();
  });
});
