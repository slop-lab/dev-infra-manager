import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../../../scripts/checks/lib/bootstrap-download.bash");
it("reuses pinned guest seed bytes offline, rejects corruption/missing/symlink inputs, and keeps a private verified copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-bootstrap-artifacts-")), cache = join(root, "cache");
  const bytes = "pinned archive bytes\n", digest = createHash("sha256").update(bytes).digest("hex");
  await mkdir(cache, { mode: 0o700 }); await writeFile(join(cache, digest), bytes);
  const fetch = (output: string) => spawnSync("bash", ["-c", 'source "$1"; dim_bootstrap_download https://offline.invalid/never-download "$2" "$3"', "fixture", helper, digest, output], {
    encoding: "utf8", env: { ...process.env, DIM_BOOTSTRAP_DOWNLOAD_CACHE: cache }
  });
  try {
    const output = join(root, "verified");
    const ok = fetch(output); expect(ok.status, ok.stderr).toBe(0);
    await writeFile(join(cache, digest), "corrupt");
    expect(await readFile(output, "utf8")).toBe(bytes);
    const corrupt = fetch(join(root, "corrupt")); expect(corrupt.status).toBe(1); expect(corrupt.stderr).toContain("SHA-256 mismatch");
    await expect(readFile(join(root, "corrupt"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(join(cache, digest));
    const missing = fetch(join(root, "missing")); expect(missing.status).toBe(1); expect(missing.stderr).toContain("missing bootstrap artifact");
    await symlink(output, join(cache, digest));
    expect(fetch(join(root, "symlink")).status).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
