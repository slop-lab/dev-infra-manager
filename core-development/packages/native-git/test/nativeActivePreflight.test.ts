import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { idleNativeConfig } from "./bundleConfigFixture.js";

const run = promisify(execFile);
const serviceCli = resolve(import.meta.dirname, "../../../../core/packages/native-git/dist/serviceCli.js");

describe("native installed registrar preflight", () => {
  it("rejects a configured registrar before Docker mutation when the trusted Git version is wrong", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-native-active-preflight-"));
    try {
      const config = join(root, "service.json");
      const password = Buffer.alloc(32, 53).toString("base64url");
      await writeFile(config, `${JSON.stringify({
        ...idleNativeConfig(), gitVersion: "0.0.0", projectRegistrars: [{
          hostId: "host-a", username: "project-registrar-a", password
        }]
      })}\n`, { mode: 0o444 });
      await chmod(config, 0o444);

      const result = run(process.execPath, [serviceCli, "check-config", config]);

      await expect(result).rejects.toMatchObject({
        stdout: "", stderr: expect.stringMatching(/expected Git 0\.0\.0/)
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
