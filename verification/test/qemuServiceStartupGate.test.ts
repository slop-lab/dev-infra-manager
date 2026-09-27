import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { waitForObservation } from "./qemuServiceTestSupport.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const serviceScript = resolve(workspaceRoot, ".dim/qemu-service.mjs");
const roots: string[] = [];
const children: ChildProcess[] = [];

function httpStatus(socketPath: string, method: string): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const outgoing = request({ socketPath, method, path: method === "GET" ? "/v1/status" : "/v1/run" }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolveStatus(incoming.statusCode ?? 0));
    });
    outgoing.once("error", rejectStatus);
    outgoing.end(method === "POST" ? JSON.stringify({ inputs: [], mode: "run" }) : undefined);
  });
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU startup admission gate", () => {
  it("returns 503 after owner publication until prepared runs activate", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-startup-gate-test-"));
    roots.push(root);
    await chmod(root, 0o755);
    const sourceRoot = resolve(root, "source");
    const runsRoot = resolve(root, "runs");
    const socketPath = resolve(root, "service.sock");
    const blocked = resolve(root, "activation-blocked");
    const release = resolve(root, "activation-release");
    const loader = resolve(root, "loader.mjs");
    const wrapper = resolve(root, "filesystem-wrapper.mjs");
    await Promise.all([mkdir(sourceRoot), mkdir(runsRoot)]);
    await writeFile(resolve(runsRoot, "sentinel"), "stale\n");
    await writeFile(loader, `import { pathToFileURL } from "node:url";
export async function resolve(specifier,context,nextResolve){if(specifier.endsWith("qemu-service-filesystem.mjs")&&!specifier.includes("?real"))return{shortCircuit:true,url:pathToFileURL(process.env.DIM_TEST_WRAPPER).href};return nextResolve(specifier,context)}`);
    await writeFile(wrapper, `import fs from "node:fs";
import * as real from ${JSON.stringify(`${pathToFileURL(resolve(workspaceRoot, ".dim/qemu-service-filesystem.mjs")).href}?real`)};
export const prepareServiceFilesystem=real.prepareServiceFilesystem,discardPreparedRuns=real.discardPreparedRuns;
export async function activatePreparedRuns(...args){await fs.promises.writeFile(process.env.DIM_TEST_BLOCKED,"blocked\\n");if(!fs.existsSync(process.env.DIM_TEST_RELEASE))await new Promise(resolveRelease=>{const watcher=fs.watch(process.env.DIM_TEST_ROOT,(_event,name)=>{if(name==="activation-release"){watcher.close();resolveRelease()}})});const result=await real.activatePreparedRuns(...args);await fs.promises.writeFile(process.env.DIM_TEST_ACTIVATED,"activated\\n");return result}`);
    const child = spawn(process.execPath, ["--experimental-loader", loader, serviceScript], {
      env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false", DIM_QEMU_SERVICE_SOCKET: socketPath,
        DIM_QEMU_SOURCE_ROOT: sourceRoot, DIM_TEST_BLOCKED: blocked, DIM_TEST_RELEASE: release,
        DIM_TEST_ACTIVATED: resolve(root, "activated"), DIM_TEST_ROOT: root, DIM_TEST_WRAPPER: wrapper },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    children.push(child);
    await Promise.race([
      waitForObservation(async () => {
        try { return (await readFile(blocked, "utf8")) === "blocked\n" ? true : undefined; }
        catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        }
      }),
      new Promise<never>((_resolveExit, rejectExit) => child.once("exit", (code) => {
        rejectExit(new TypeError(`service exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      })),
    ]);

    expect.soft(await httpStatus(socketPath, "GET")).toBe(503);
    expect.soft(await httpStatus(socketPath, "POST")).toBe(503);
    expect.soft(await readFile(resolve(runsRoot, "sentinel"), "utf8")).toBe("stale\n");
    await writeFile(release, "release\n");
    await waitForObservation(async () => {
      try { return (await lstat(resolve(root, "activated"))).isFile() ? true : undefined; }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    });
    const accepting = await waitForObservation(async () => {
      return await httpStatus(socketPath, "GET") === 200 ? true : undefined;
    });
    expect(accepting).toBe(true);
  });
});