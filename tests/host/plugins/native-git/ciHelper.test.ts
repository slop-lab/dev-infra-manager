import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const helper = new URL("../../../../packages/host/plugins/native-git/src/guest/dim-ci.mjs", import.meta.url).pathname;
it("offers offline help and rejects unknown request flags before Git or credential lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-cli-"));
  const environment = { HOME: root, PATH: "" };
  try {
    const help = await promisify(execFile)(process.execPath, [helper, "--help"], { cwd: root, env: environment, timeout: 2000 });
    expect(help.stdout).toContain("--request-id"); expect(help.stderr).toBe("");
    try {
      await promisify(execFile)(process.execPath, [helper, "request", "--request-id", "c946b18f-08bb-4f33-a06d-ea2d4de18d74", "--job-schema", "PRIVATE_INPUT"], { cwd: root, env: environment, timeout: 2000 });
      throw new Error("unsupported request flag was accepted");
    } catch (error) {
      if (!(error instanceof Error) || !("stderr" in error) || typeof error.stderr !== "string" || !("code" in error)) throw error;
      expect(error.code).toBe(2); expect(error.stderr).toContain("--request-id"); expect(error.stderr).not.toContain("PRIVATE_INPUT");
    }
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
