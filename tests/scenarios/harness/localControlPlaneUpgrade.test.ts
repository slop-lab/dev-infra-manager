import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureServiceLogs, forwardReadable, restoreVolumes, type VolumeCheckpoint } from "../../../scripts/local-control-plane/checkpoint.ts";
import type { ControlPlaneDockerRunner } from "../../../packages/installer/src/controlPlaneDockerTypes.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function pair() {
  const directory = await mkdtemp(join(tmpdir(), "dim-local-control-plane-checkpoint-")); directories.push(directory);
  const checkpoints: VolumeCheckpoint[] = [];
  for (const service of ["native-git", "execution"] as const) {
    const bytes = Buffer.from(`private ${service} snapshot`);
    await writeFile(join(directory, `${service}.tar`), bytes, { mode: 0o600 });
    checkpoints.push({ service, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { directory, checkpoints };
}
it("checks both archive digests before allowing any old-format volume restoration", async () => {
  const { directory, checkpoints } = await pair();
  await writeFile(join(directory, "execution.tar"), "damaged execution snapshot", { mode: 0o600 });
  let dockerCalls = 0;
  const runner: ControlPlaneDockerRunner = { async run() { dockerCalls++; throw new Error("must not mutate the first volume"); } };
  await expect(restoreVolumes(runner, "unused-image", directory, checkpoints)).rejects.toThrow(/digest changed/);
  expect(dockerCalls).toBe(0);
});
it("refuses incomplete checkpoint pairs before any Docker operation", async () => {
  const { directory, checkpoints } = await pair();
  const runner: ControlPlaneDockerRunner = { async run() { throw new Error("must not be called"); } };
  await expect(restoreVolumes(runner, "unused-image", directory, checkpoints.slice(0, 1))).rejects.toThrow(/both exact/);
});
it("does not follow replacement symlinks in recovery checkpoints", async () => {
  const { directory, checkpoints } = await pair();
  await rm(join(directory, "native-git.tar"));
  await symlink(join(directory, "execution.tar"), join(directory, "native-git.tar"));
  const runner: ControlPlaneDockerRunner = { async run() { throw new Error("must not mutate data"); } };
  await expect(restoreVolumes(runner, "unused-image", directory, checkpoints)).rejects.toThrow();
});
it("permits a real forward-readable format upgrade without claiming reverse compatibility", async () => {
  const runner: ControlPlaneDockerRunner = { async run({ args }) {
    const value = args.includes("compatibility") ? { schemaVersion: 1, writeFormat: 11, readableFormats: [10, 11] }
      : { schemaVersion: 1, stateFormat: 10 };
    return { exitCode: 0, stderr: "", stdout: `${JSON.stringify(value)}\n` };
  } };
  await expect(forwardReadable(runner, "new-image", "native-git")).resolves.toBeUndefined();
});
it("refuses a candidate that cannot read the stopped state format", async () => {
  const runner: ControlPlaneDockerRunner = { async run({ args }) {
    const value = args.includes("compatibility") ? { schemaVersion: 1, writeFormat: 11, readableFormats: [11] }
      : { schemaVersion: 1, stateFormat: 10 };
    return { exitCode: 0, stderr: "", stdout: `${JSON.stringify(value)}\n` };
  } };
  await expect(forwardReadable(runner, "new-image", "native-git")).rejects.toThrow(/cannot read/);
});

it("retains bounded service logs privately and continues capturing when another service fails", async () => {
  const { directory } = await pair();
  const calls: string[] = [];
  const runner: ControlPlaneDockerRunner = { async run({ args, timeoutMilliseconds, maximumOutputBytes }) {
    expect(timeoutMilliseconds).toBe(10_000);
    expect(maximumOutputBytes).toBe(256 * 1024);
    const id = args.at(-1)!; calls.push(id);
    if (id === "native-container") throw new Error("log capture unavailable");
    return { exitCode: 0, stdout: "private service output", stderr: "private service error" };
  } };
  await expect(captureServiceLogs(runner, directory, {
    nativeGitContainerId: "native-container", executionContainerId: "execution-container"
  })).resolves.toBeUndefined();
  expect(calls.sort()).toEqual(["execution-container", "native-container"]);
  const file = join(directory, "diagnostics-execution.log");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, "utf8")).toBe("private service outputprivate service error");
});
it("does not block recovery when private diagnostic files cannot be created", async () => {
  const { directory } = await pair();
  const runner: ControlPlaneDockerRunner = { async run() { return { exitCode: 0, stdout: "private logs", stderr: "" }; } };
  await expect(captureServiceLogs(runner, join(directory, "absent"), {
    nativeGitContainerId: "native-container", executionContainerId: "execution-container"
  })).resolves.toBeUndefined();
});
