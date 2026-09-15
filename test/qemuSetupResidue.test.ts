import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { socketLeasePath } from "../../project/.dim/qemu-service-artifacts.mjs";
import { startService, waitForExit } from "./qemuServiceTestSupport.js";
import { processIsLive } from "./qemuSetupTestSupport.js";

const projectRoot = resolve(import.meta.dirname, "../../project");
const ownerScript = resolve(projectRoot, ".dim/qemu-service-owner.mjs");
const roots: string[] = [];

async function setupSection(serviceDirectory: string, tools: string): Promise<string> {
  const setup = await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8");
  const start = setup.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
  const end = setup.indexOf("\n# Avoid inheriting", start);
  await writeFile(resolve(tools, "sudo"), "#!/bin/sh\n[ \"$1\" != -n ] || shift\nexec \"$@\"\n");
  await chmod(resolve(tools, "sudo"), 0o700);
  return `set -eu\n${setup.slice(start, end)
    .replace("qemu_service_dir=/tmp/dim-qemu-verification", `qemu_service_dir=${JSON.stringify(serviceDirectory)}`)
    .replace("qemu_node=/usr/bin/node", `qemu_node=${JSON.stringify(process.execPath)}`)}`;
}

async function runSetup(serviceDirectory: string) {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-setup-residue-test-"));
  roots.push(root);
  const tools = resolve(root, "tools");
  await mkdir(tools);
  return spawnSync("/bin/sh", ["-c", await setupSection(serviceDirectory, tools)], {
    cwd: projectRoot, encoding: "utf8", env: { ...process.env, DIM_WORKSPACE_KVM: "1", PATH: `${tools}:/usr/bin:/bin` }, timeout: 20_000,
  });
}

function recordPid(value: unknown): string {
  if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "string") {
    throw new TypeError("structured owner PID is missing");
  }
  return value.pid;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("integrated QEMU setup residue contract", () => {
  it("removes complete dead structured residue before starting replacement", async () => {
    const service = await startService("hold", { serviceCwd: projectRoot });
    const ownerPath = resolve(service.root, "service-owner.json");
    const oldOwner = await lstat(ownerPath, { bigint: true });
    service.process.kill("SIGKILL");
    expect(await waitForExit(service)).toBe(true);

    const result = await runSetup(service.root);
    const replacementPid = recordPid(JSON.parse(await readFile(ownerPath, "utf8")));

    expect.soft(result.status, result.stderr).toBe(0);
    expect.soft((await lstat(ownerPath, { bigint: true })).ino).not.toBe(oldOwner.ino);
    expect.soft(replacementPid).not.toBe(String(service.process.pid));
    const retired = spawnSync(process.execPath, [ownerScript, "retire", ownerPath, service.socketPath, projectRoot, "5000"], { encoding: "utf8" });
    expect(retired.status, retired.stderr).toBe(0);
  }, 25_000);

  it.each(["malformed", "argv-mismatch"] as const)("preserves complete %s ownership without replacement", async (kind) => {
    const service = await startService("hold", { serviceCwd: projectRoot });
    const ownerPath = resolve(service.root, "service-owner.json");
    const original = await readFile(ownerPath, "utf8");
    const changed = kind === "malformed" ? "not-json\n" : `${JSON.stringify({ ...JSON.parse(original), argv: ["spoofed"] })}\n`;
    await writeFile(ownerPath, changed, { mode: 0o600 });
    const before = await Promise.all([ownerPath, service.socketPath, socketLeasePath(service.socketPath)].map((path) => lstat(path, { bigint: true })));

    const result = await runSetup(service.root);
    const after = await Promise.all([ownerPath, service.socketPath, socketLeasePath(service.socketPath)].map((path) => lstat(path, { bigint: true })));

    expect.soft(result.status).not.toBe(0);
    expect.soft(processIsLive(service.process.pid ?? 0)).toBe(true);
    expect.soft(after.map(({ dev, ino }) => ({ dev, ino }))).toEqual(before.map(({ dev, ino }) => ({ dev, ino })));
    expect(await readFile(ownerPath, "utf8")).toBe(changed);
  });

  it.each([
    [true, false, false], [false, false, true], [true, false, true],
    [false, true, true], [true, true, false],
  ] as const)(
    "preserves partial owner=%s socket=%s lease=%s without replacement", async (owner, socket, lease) => {
      const service = await startService("hold", { serviceCwd: projectRoot });
      const paths = [resolve(service.root, "service-owner.json"), service.socketPath, socketLeasePath(service.socketPath)];
      for (const [present, path] of [[owner, paths[0]], [socket, paths[1]], [lease, paths[2]]] as const) if (!present && path) await rm(path);
      const present = paths.filter((_path, index) => [owner, socket, lease][index]);
      const before = await Promise.all(present.map((path) => lstat(path, { bigint: true })));
      const ownerContent = owner ? await readFile(paths[0] ?? "missing", "utf8") : undefined;

      const result = await runSetup(service.root);
      const after = await Promise.all(present.map((path) => lstat(path, { bigint: true })));

      expect.soft(result.status).not.toBe(0);
      expect.soft(processIsLive(service.process.pid ?? 0)).toBe(true);
      expect.soft(after.map(({ dev, ino }) => ({ dev, ino }))).toEqual(before.map(({ dev, ino }) => ({ dev, ino })));
      if (ownerContent !== undefined) expect(await readFile(paths[0] ?? "missing", "utf8")).toBe(ownerContent);
    },
  );
});
