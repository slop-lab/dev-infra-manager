import { spawn } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { deployGuestIntegration, type GuestIntegrationContext } from "../../../packages/host/core/src/workspace/guestIntegration.js";
import type { WorkspaceRecord } from "../../../packages/host/core/src/workspace/models.js";
import type { WorkspaceExecOptions } from "../../../packages/host/core/src/workspace/service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "dim-integration-")); roots.push(root); return root; }
function record(): WorkspaceRecord { return { schemaVersion: 10, id: randomUUID(), name: "fixture", runtime: "container", image: "fixture",
  source: { url: "/source", ref: "refs/heads/main", commit: "a".repeat(40) }, resources: { cpuCount: "1", memory: "1g", pidsLimit: "256" },
  git: { name: "Fixture", email: "fixture@example.invalid" }, initialized: true, phase: "running", createdAt: "now", updatedAt: "now" }; }
function run(home: string, command: string[], options: WorkspaceExecOptions, preload?: string): Promise<number> {
  if (command[0] !== "node") throw new Error("fixture executes only the guest Node writer");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ["--require", preload] : []), ...command.slice(1)], {
      env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"], signal: options.signal
    });
    child.once("error", reject); child.once("close", (code) => resolve(code ?? 128));
    if (options.stdin) options.stdin.pipe(child.stdin); else child.stdin.end();
    if (options.stdout) child.stdout.pipe(options.stdout, { end: false }); else child.stdout.resume();
    if (options.stderr) child.stderr.pipe(options.stderr, { end: false }); else child.stderr.resume();
  });
}
function context(home: string, preload?: string) {
  const workspace = record(), calls: string[][] = [];
  const value: GuestIntegrationContext = { workspace, signal: new AbortController().signal,
    service: { async exec(name, command, options = {}) {
      expect(name).toBe(workspace.name); expect(options.workspaceId).toBe(workspace.id);
      calls.push(command); return run(home, command, options, preload);
    } } };
  return { value, calls };
}
it("publishes exact private guest bytes, keeps unchanged files, and never places credentials in argv", async () => {
  const home = await directory(), { value, calls } = context(home), secret = "workspace-only-private-token";
  const integration = { name: "fixture", files: [
    { path: ".config/dim/fixture.json", contents: JSON.stringify({ secret }) },
    { path: ".local/bin/dim-fixture", contents: new Uint8Array([0, 1, 255]), mode: 0o700 as const }
  ] };
  await deployGuestIntegration(value, integration);
  const file = join(home, ".config/dim/fixture.json"), before = await stat(file);
  expect(before.mode & 0o777).toBe(0o600);
  expect(await readFile(join(home, ".local/bin/dim-fixture"))).toEqual(Buffer.from([0, 1, 255]));
  expect((await stat(join(home, ".local/bin/dim-fixture"))).mode & 0o777).toBe(0o700);
  await deployGuestIntegration(value, integration);
  expect((await stat(file)).ino).toBe(before.ino); expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  await chmod(file, 0o644); await deployGuestIntegration(value, integration);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(calls.flat().join(" ")).not.toContain(secret);
});
it("rejects symlink ancestors, leaf symlinks and multiply linked files without changing outside data", async () => {
  const home = await directory(), outside = await directory(), { value } = context(home);
  const integration = { name: "fixture", files: [{ path: ".config/secret", contents: "private" }] };
  await writeFile(join(outside, "secret"), "outside", { mode: 0o600 });
  await symlink(outside, join(home, ".config"));
  await expect(deployGuestIntegration(value, integration)).rejects.toThrow(/cannot safely prepare/);
  await rm(join(home, ".config")); await mkdir(join(home, ".config"), { mode: 0o700 });
  await symlink(join(outside, "secret"), join(home, ".config/secret"));
  await expect(deployGuestIntegration(value, integration)).rejects.toThrow(/cannot safely prepare/);
  await rm(join(home, ".config/secret")); await link(join(outside, "secret"), join(home, ".config/secret"));
  await expect(deployGuestIntegration(value, integration)).rejects.toThrow(/cannot safely prepare/);
  expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside");
});
it("directory descriptors prevent an ancestor swapped to a symlink from redirecting writes", async () => {
  const home = await directory(), outside = await directory(), preload = join(home, "swap.cjs");
  await mkdir(join(home, ".config"), { mode: 0o700 });
  await writeFile(preload, `const fs=require('node:fs'),original=fs.openSync;let swapped=false;
fs.openSync=function(file,...args){const fd=original.call(this,file,...args);
if(!swapped&&typeof file==='string'&&file.endsWith('/.config')){swapped=true;fs.renameSync(${JSON.stringify(join(home, ".config"))},${JSON.stringify(join(home, "moved"))});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(join(home, ".config"))});}return fd;};`);
  await deployGuestIntegration(context(home, preload).value, { name: "fixture", files: [{ path: ".config/dim/connection", contents: "guest-only-secret" }] });
  expect(await readFile(join(home, "moved/dim/connection"), "utf8")).toBe("guest-only-secret");
  await expect(readFile(join(outside, "dim/connection"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("reopens an owner-valid leaf replaced between open and fstat without consuming the unlinked inode", async () => {
  const home = await directory(), preload = join(home, "replace-leaf.cjs"), marker = join(home, "replaced");
  const original = { name: "fixture", files: [{ path: ".config/dim/connection", contents: "previous-guest-credential" }] };
  await deployGuestIntegration(context(home).value, original);
  await writeFile(preload, `const fs=require('node:fs'),original=fs.openSync;let replaced=false;
fs.openSync=function(file,...args){const fd=original.call(this,file,...args);
if(!replaced&&typeof file==='string'&&file.endsWith('/connection')){
 replaced=true;fs.writeFileSync(file+'.replacement','concurrent-publication',{mode:0o600});fs.renameSync(file+'.replacement',file);fs.writeFileSync(${JSON.stringify(marker)},'done');
}return fd;};`);
  const changed = { name: "fixture", files: [{ path: ".config/dim/connection", contents: "desired-guest-credential" }] };
  await deployGuestIntegration(context(home, preload).value, changed);
  expect(await readFile(marker, "utf8")).toBe("done");
  expect(await readFile(join(home, ".config/dim/connection"), "utf8")).toBe("desired-guest-credential");
  // Concurrent refreshes converge on the same desired bytes and remain safe.
  await Promise.all(Array.from({ length: 12 }, () => deployGuestIntegration(context(home).value, original)));
  expect(await readFile(join(home, ".config/dim/connection"), "utf8")).toBe("previous-guest-credential");
});
it("bounds repeated leaf replacement rather than accepting permanently unstable metadata", async () => {
  const home = await directory(), preload = join(home, "unstable-leaf.cjs"), marker = join(home, "replacements");
  const integration = { name: "fixture", files: [{ path: ".config/connection", contents: "wanted" }] };
  await deployGuestIntegration(context(home).value, integration);
  await writeFile(preload, `const fs=require('node:fs'),original=fs.openSync;
fs.openSync=function(file,...args){const fd=original.call(this,file,...args);
if(typeof file==='string'&&file.endsWith('/connection')){
 fs.writeFileSync(file+'.replacement','concurrent',{mode:0o600});fs.renameSync(file+'.replacement',file);fs.appendFileSync(${JSON.stringify(marker)},'x');
}return fd;};`);
  await expect(deployGuestIntegration(context(home, preload).value, integration)).rejects.toThrow(/cannot safely prepare/);
  expect(await readFile(marker, "utf8")).toBe("xxxxx");
});
it("rejects traversal, overlapping paths and oversize payloads before starting any guest process", async () => {
  const { value, calls } = context(await directory());
  for (const path of ["/root/secret", "../secret", "a/../secret", "a\\secret", "a//secret"]) {
    await expect(deployGuestIntegration(value, { name: "fixture", files: [{ path, contents: "x" }] })).rejects.toThrow(/HOME-relative/);
  }
  await expect(deployGuestIntegration(value, { name: "fixture", files: [{ path: "a", contents: "x" }, { path: "a/b", contents: "y" }] })).rejects.toThrow(/parent directories/);
  await expect(deployGuestIntegration(value, { name: "fixture", files: [{ path: "a", contents: Buffer.alloc(4 * 1024 * 1024 + 1) }] })).rejects.toThrow(/budget/);
  expect(calls).toEqual([]);
});
it("pins an explicit nested container to its inspected ID inside the immutable workspace", async () => {
  const workspaceHome = await directory(), nestedHome = await directory(), workspace = record(), id = "a".repeat(64), calls: string[][] = [];
  const value: GuestIntegrationContext = { workspace, signal: new AbortController().signal, service: { async exec(name, command, options = {}) {
    expect(name).toBe(workspace.name); expect(options.workspaceId).toBe(workspace.id); calls.push(command);
    if (command[1] === "container") { options.stdout?.write(`${id}\n`); return 0; }
    expect(command.slice(0, 7)).toEqual(["docker", "exec", "--interactive", "--user", "1000", "--", id]);
    return run(nestedHome, command.slice(7), options);
  } } };
  await deployGuestIntegration(value, { name: "fixture", target: { container: "agent", user: "1000" }, files: [{ path: ".config/dim/nested", contents: "target-only" }] });
  expect(calls[0]).toEqual(["docker", "container", "inspect", "--format", "{{.Id}}", "--", "agent"]);
  expect(await readFile(join(nestedHome, ".config/dim/nested"), "utf8")).toBe("target-only");
  await expect(readFile(join(workspaceHome, ".config/dim/nested"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(deployGuestIntegration(value, { name: "fixture", target: { container: "--host" }, files: [] })).rejects.toThrow(/nested integration target/);
});

it("prepares explicit directory-only integrations through the same private anchored writer", async () => {
  const home = await directory(), { value } = context(home);
  const integration = { name: "directories", directories: [".config/dim", ".local/share/client"], files: [] };
  await deployGuestIntegration(value, integration);
  const target = join(home, ".config/dim"), before = await stat(target);
  expect(before.isDirectory()).toBe(true); expect(before.mode & 0o777).toBe(0o700);
  await deployGuestIntegration(value, integration);
  expect((await stat(target)).ino).toBe(before.ino);
  await chmod(target, 0o777);
  await expect(deployGuestIntegration(value, integration)).rejects.toThrow(/cannot safely prepare/);
});

it("rejects redirected or foreign-owned directory preparation without creating outside entries", async () => {
  const home = await directory(), outside = await directory();
  await symlink(outside, join(home, ".config"));
  await expect(deployGuestIntegration(context(home).value, { name: "directories", directories: [".config/dim"], files: [] })).rejects.toThrow(/cannot safely prepare/);
  await expect(stat(join(outside, "dim"))).rejects.toMatchObject({ code: "ENOENT" });
  // The system temporary directory belongs to root rather than the guest user.
  if ((await stat(tmpdir())).uid !== process.getuid?.()) {
    const name = `dim-foreign-directory-${randomUUID()}`;
    await expect(deployGuestIntegration(context(tmpdir()).value, { name: "directories", directories: [name], files: [] })).rejects.toThrow(/cannot safely prepare/);
    await expect(stat(join(tmpdir(), name))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("rejects directory traversal, duplicate paths, file conflicts and combined path overflow before execution", async () => {
  const { value, calls } = context(await directory());
  for (const path of ["/absolute", "../outside", "a/../outside", "a\\b", "a//b"]) {
    await expect(deployGuestIntegration(value, { name: "directories", directories: [path], files: [] })).rejects.toThrow(/HOME-relative/);
  }
  await expect(deployGuestIntegration(value, { name: "directories", directories: ["same", "same"], files: [] })).rejects.toThrow(/distinct/);
  await expect(deployGuestIntegration(value, { name: "directories", directories: ["a"], files: [{ path: "a", contents: "x" }] })).rejects.toThrow(/also be directories/);
  await expect(deployGuestIntegration(value, { name: "directories", directories: ["a/b"], files: [{ path: "a", contents: "x" }] })).rejects.toThrow(/parent directories/);
  await expect(deployGuestIntegration(value, { name: "directories", directories: Array.from({ length: 64 }, (_, index) => `d${index}`), files: [{ path: "file", contents: "x" }] })).rejects.toThrow(/file count/);
  expect(calls).toEqual([]);
});
