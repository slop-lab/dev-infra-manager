import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, stat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishPublicJobFiles } from "../../../../packages/host/plugins/execution-worker/src/publicJobFiles.js";
it("normalizes every public file/directory under umask077 without changing private siblings or Git executable identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-public-job-")), previous = process.umask(0o077);
  try {
    const job = join(root, "job"), nested = join(job, "source-context/parents/hash/deep"), hardware = join(root, "hardware");
    await mkdir(nested, { recursive: true, mode: 0o755 }); await mkdir(hardware, { mode: 0o700 });
    for (const file of ["descriptor.json", "working-directory", "config-targets", "config-0", "job-environment", "source-context/context.json", "source-context/candidate.commit", "source-context/parent.commit", "source-context/parents/hash/deep/file"])
      await writeFile(join(job, file), "public", { mode: 0o444 });
    await writeFile(join(nested, "executable"), "#!/bin/sh\n", { mode: 0o755 });
    expect((await stat(join(job, "descriptor.json"))).mode & 0o777).toBe(0o400);
    await publishPublicJobFiles(job);
    for (const file of ["descriptor.json", "working-directory", "config-targets", "config-0", "job-environment", "source-context/context.json", "source-context/candidate.commit", "source-context/parent.commit", "source-context/parents/hash/deep/file"])
      expect((await stat(join(job, file))).mode & 0o777).toBe(0o444);
    for (const directory of [job, join(job, "source-context"), join(job, "source-context/parents"), join(job, "source-context/parents/hash"), nested])
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect((await stat(join(nested, "executable"))).mode & 0o777).toBe(0o555);
    expect((await stat(root)).mode & 0o777).toBe(0o700); expect((await stat(hardware)).mode & 0o777).toBe(0o700);
  } finally { process.umask(previous); await rm(root, { recursive: true, force: true }); }
});
it("refuses links rather than chmoding files outside its public tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-public-link-"));
  try { const job = join(root, "job"), privateFile = join(root, "private"); await mkdir(job); await writeFile(privateFile, "private", { mode: 0o600 }); await symlink(privateFile, join(job, "link"));
    await expect(publishPublicJobFiles(job)).rejects.toThrow("ownership mismatch"); expect((await stat(privateFile)).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
