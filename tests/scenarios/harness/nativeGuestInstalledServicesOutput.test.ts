import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([0, 19])("bounds installed-service console output without losing status %s or private details", async (status) => {
  const root = await mkdtemp(join(tmpdir(), "dim-guest-service-output-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "just"), `#!${process.execPath}\nrequire("node:fs").writeSync(1, "x".repeat(256 * 1024)); process.exit(${status});\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["scripts/checks/kvm-guest-verification-smoke.bash"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        DIM_VERIFICATION_INTERNAL_STAGE: "installed-services", DIM_VERIFICATION_LOG_ROOT: root },
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024
    });
    expect(result.status).toBe(status);
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(20 * 1024);
    expect((await readFile(join(root, "installed-services-detail.log"))).byteLength).toBeGreaterThanOrEqual(256 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
