import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeHostPrivateRoot, type NativeHostPrivateRootIdentity } from "../../../packages/host/plugins/execution-worker/src/private-root.js";
import { ProcessRunner } from "@slop-lab/dim-host-core";
import { assignment, grant } from "../../contracts/ci/executionFixture.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it.skipIf(!process.env.DIM_TEST_EXECUTION_ROOT_CLEANUP_IMAGE)("cleans real root-owned guest files through only the verified root without following a symlink", { timeout: 30_000 }, async () => {
    const image = process.env.DIM_TEST_EXECUTION_ROOT_CLEANUP_IMAGE!;
    const selected = assignment(), claim = grant({ ...selected, profile: { ...selected.profile, runnerBaseImage: image } });
    const journal = await temporaryPrivateRoots(), runner = new ProcessRunner();
    const commands = vi.spyOn(runner, "run");
    const root = journal.privateRoot({ schemaVersion: 1, state: "planned", rootId: "98000000-0000-4000-8000-000000000001" });
    await root.create(claim.executionId);
    const outside = join(dirname(root.path), "outside"); await mkdir(outside); await writeFile(join(outside, "retain"), "foreign");
    await symlink(outside, join(root.path, "escape"));
    const created = await runner.run("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--read-only",
      "--userns", "host", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE",
      "--mount", `type=bind,source=${root.path},target=/work`, "--entrypoint", "/bin/sh", image, "-eu", "-c",
      "mkdir /work/guest; printf root-owned > /work/guest/file; chmod 700 /work/guest; chmod 600 /work/guest/file"
    ], { signal: AbortSignal.timeout(15_000) });
    expect(created.exitCode).toBe(0);
    try {
      expect((await lstat(join(root.path, "guest"))).uid).toBe(0);
      expect(await root.cleanup(claim.executionId, { runner, grant: claim })).toBe(true);
      const helper = commands.mock.calls.find(([, args]) => args.includes("dim-private-root-cleanup"))?.[1];
      expect(helper).toBeDefined();
      expect(helper?.filter((arg) => arg === "--mount")).toHaveLength(1);
      expect(helper).toContain(`type=bind,source=${root.path},target=/work`);
      expect(helper).toContain(image);
      expect(helper).not.toContain(claim.descriptor.jobImage);
      expect(helper).not.toContain("--privileged");
      expect(helper?.some((arg) => arg.includes("docker.sock"))).toBe(false);
      await expect(lstat(root.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(outside, "retain"), "utf8")).toBe("foreign");
    } finally { await root.cleanup(claim.executionId, { runner, grant: claim }); }
  });

async function temporaryPrivateRoots() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-test-"));
  roots.push(root); await chmod(root, 0o700);
  return { privateRoot: (identity: NativeHostPrivateRootIdentity) => new NativeHostPrivateRoot(root, identity) };
}
