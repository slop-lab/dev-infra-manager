import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const serviceScript = resolve(import.meta.dirname, "../../.dim/qemu-service.mjs");
const roots: string[] = [];
const children: ChildProcess[] = [];

function waitForFile(path: string): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const directory = resolve(path, "..");
    const filename = path.slice(directory.length + 1);
    const observer = watch(directory, (_event, changed) => {
      if (changed?.toString() !== filename) return;
      observer.close();
      resolveReady();
    });
    readFile(path).then(() => {
      observer.close();
      resolveReady();
    }, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        observer.close();
        rejectReady(error);
      }
    });
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU setup owner PID", () => {
  it("publishes the real Node PID independently of its background shell wrapper", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-wrapper-pid-test-"));
    roots.push(root);
    await chmod(root, 0o755);
    const sourceRoot = resolve(root, "source");
    const wrapperPath = resolve(root, "wrapper.pid");
    const ownerPath = resolve(root, "service-owner.json");
    await mkdir(sourceRoot);
    const command = `"${process.execPath}" "${serviceScript}" & child=$!; printf '%s\\n' "$$" >"${wrapperPath}"; wait "$child"`;
    const wrapper = spawn("/usr/bin/bash", ["-c", command], {
      env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false", DIM_QEMU_SERVICE_SOCKET: resolve(root, "service.sock"), DIM_QEMU_SOURCE_ROOT: sourceRoot },
      stdio: "ignore",
    });
    children.push(wrapper);
    await Promise.race([
      waitForFile(ownerPath),
      new Promise<never>((_resolve, reject) => wrapper.once("exit", (code, signal) => {
        reject(new TypeError(`QEMU wrapper exited before owner publication: ${code ?? signal}`));
      })),
    ]);
    const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    if (typeof owner !== "object" || owner === null || !("pid" in owner) || typeof owner.pid !== "string") {
      throw new TypeError("structured owner PID is missing");
    }

    expect(owner.pid).not.toBe((await readFile(wrapperPath, "utf8")).trim());
    process.kill(Number.parseInt(owner.pid, 10), "SIGTERM");
    await new Promise<void>((resolveExit) => wrapper.once("exit", () => resolveExit()));
  });
});