import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../packages/cli/core/src/cli.ts", import.meta.url));
const peer = fileURLToPath(new URL("./fixtures/copy-host-peer.ts", import.meta.url));
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("public cp round trips files and recursive trees through local and SSH selected hosts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-roundtrip-"));
  try {
    const guest = path.join(root, "guest"); const bin = path.join(root, "bin"); await mkdir(guest); await mkdir(bin);
    const endpoint = path.join(bin, "dim-host");
    const launch = `#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(import.meta.resolve("tsx"))} ${shell(peer)} "$@"\n`;
    await writeFile(endpoint, launch, { mode: 0o700 }); await writeFile(path.join(bin, "dim"), launch, { mode: 0o700 });
    await writeFile(path.join(bin, "ssh"), "#!/bin/sh\nshift 3\nexec /bin/sh -c \"$1\"\n", { mode: 0o700 });
    const run = (args: readonly string[], input = Buffer.alloc(0)) => command(root, guest, endpoint, bin, args, input);

    const binary = Buffer.from([0, 1, 255, 10, 13]); const local = path.join(root, "local.bin"); await writeFile(local, binary);
    let result = await run(["cp", local, "dev:/data.bin"]); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.length, 0);
    result = await run(["cp", "dev:/data.bin", "-"]); assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.stdout, binary);
    result = await run(["cp", "-", "dev:/stdin.bin"], binary); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(path.join(guest, "stdin.bin")), binary);

    for (const [index, name] of ["1-test", "foo_bar", "foo.bar", "a".repeat(48)].entries()) {
      result = await run(["cp", local, `${name}:/valid-${index}`]);
      assert.equal(result.status, 0, result.stderr);
      result = await run(["cp", `${name}:/valid-${index}`, "-"]);
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.stdout, binary);
    }
    const tree = path.join(root, "tree"); await mkdir(path.join(tree, "nested"), { recursive: true });
    await writeFile(path.join(tree, "nested", "tool"), "tool"); await chmod(path.join(tree, "nested", "tool"), 0o750);
    await symlink("nested/tool", path.join(tree, "tool-link"));
    await run(["host", "add", "remote", "--ssh", "fixture"]); await run(["host", "use", "remote"]);
    result = await run(["cp", "--recursive", tree, "dev:/tree"]); assert.equal(result.status, 0, result.stderr);
    const downloaded = path.join(root, "downloaded"); result = await run(["cp", "--recursive", "dev:/tree", downloaded]); assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(downloaded, "nested", "tool"), "utf8"), "tool");
    assert.equal(await readlink(path.join(downloaded, "tool-link")), "nested/tool");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public cp preserves destinations on errors and requires explicit overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-errors-"));
  try {
    const guest = path.join(root, "guest"); const bin = path.join(root, "bin"); await mkdir(guest); await mkdir(bin);
    const endpoint = path.join(bin, "dim-host");
    await writeFile(endpoint, `#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(import.meta.resolve("tsx"))} ${shell(peer)} "$@"\n`, { mode: 0o700 });
    const source = path.join(root, "source"); await writeFile(source, "new"); await writeFile(path.join(guest, "target"), "old-long-value");
    let result = await command(root, guest, endpoint, bin, ["cp", source, "dev:/target"], Buffer.alloc(0));
    assert.equal(result.status, 2); assert.match(result.stderr, /--overwrite/); assert.equal(await readFile(path.join(guest, "target"), "utf8"), "old-long-value");
    result = await command(root, guest, endpoint, bin, ["cp", "--overwrite", source, "dev:/target"], Buffer.alloc(0));
    assert.equal(result.status, 0, result.stderr); assert.equal(await readFile(path.join(guest, "target"), "utf8"), "new");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed empty downloads and closed output sinks terminate without waiting for archive bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-stream-errors-"));
  try {
    const guest = path.join(root, "guest"); const bin = path.join(root, "bin"); await mkdir(guest); await mkdir(bin);
    const endpoint = path.join(bin, "dim-host");
    await writeFile(endpoint, `#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(import.meta.resolve("tsx"))} ${shell(peer)} "$@"\n`, { mode: 0o700 });
    const failed = await command(root, guest, endpoint, bin, ["cp", "dev:/fail-empty", path.join(root, "unchanged")], Buffer.alloc(0));
    assert.equal(failed.status, 2); assert.match(failed.stderr, /copy source failed/);

    await writeFile(path.join(guest, "large"), Buffer.alloc(4 * 1024 * 1024, 9));
    const child = spawn(process.execPath, ["--conditions=dim-source", "--import", import.meta.resolve("tsx"), cli, "cp", "dev:/large", "-"], {
      env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), DIM_HOST_EXECUTABLE: endpoint, DIM_COPY_GUEST_ROOT: guest },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await onceData(child.stdout); child.stdout.destroy(new Error("closed output sink"));
    const status = await closeWithin(child);
    assert.notEqual(status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("download publishes only after host success and aborts a malicious early archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-publish-gate-"));
  try {
    const guest = path.join(root, "guest"); const bin = path.join(root, "bin"); await mkdir(guest); await mkdir(bin);
    const endpoint = path.join(bin, "dim-host");
    await writeFile(endpoint, `#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(import.meta.resolve("tsx"))} ${shell(peer)} "$@"\n`, { mode: 0o700 });
    await writeFile(path.join(guest, "archive-exit-7"), "new");
    const destination = path.join(root, "destination"); await writeFile(destination, "old");
    const failed = await command(root, guest, endpoint, bin, ["cp", "--overwrite", "dev:/archive-exit-7", destination], Buffer.alloc(0));
    assert.equal(failed.status, 7); assert.equal(await readFile(destination, "utf8"), "old");
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".dim-copy-")), []);

    const malicious = await command(root, guest, endpoint, bin, ["cp", "dev:/malicious-hang", path.join(root, "malicious")], Buffer.alloc(0));
    assert.equal(malicious.status, 2); assert.match(malicious.stderr, /unsafe copy archive path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("copy accepts -- before stdin and literal dash-prefixed operands", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-option-end-"));
  try {
    const guest = path.join(root, "guest"); const bin = path.join(root, "bin"); await mkdir(guest); await mkdir(bin);
    const endpoint = path.join(bin, "dim-host");
    await writeFile(endpoint, `#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(import.meta.resolve("tsx"))} ${shell(peer)} "$@"\n`, { mode: 0o700 });
    const result = await command(root, guest, endpoint, bin, ["cp", "--", "-", "dev:/literal"], Buffer.from("literal"));
    assert.equal(result.status, 0, result.stderr); assert.equal(await readFile(path.join(guest, "literal"), "utf8"), "literal");
    await writeFile(path.join(root, "-source"), "dash path");
    const dashed = await command(root, guest, endpoint, bin, ["cp", "--", "-source", "dev:/dash-path"], Buffer.alloc(0), root);
    assert.equal(dashed.status, 0, dashed.stderr); assert.equal(await readFile(path.join(guest, "dash-path"), "utf8"), "dash path");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelling stdin copy removes operator staging and keeps the conventional signal status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-copy-cancel-"));
  try {
    const guest = path.join(root, "guest"); const bin = path.join(root, "bin"); const temporary = path.join(root, "tmp");
    await mkdir(guest); await mkdir(bin); await mkdir(temporary);
    const endpoint = path.join(bin, "dim-host"); const ready = path.join(root, "ready");
    await writeFile(endpoint, `#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(import.meta.resolve("tsx"))} ${shell(peer)} "$@"\n`, { mode: 0o700 });
    const child = spawn(process.execPath, ["--conditions=dim-source", "--import", import.meta.resolve("tsx"), cli, "cp", "-", "dev:/cancelled"], {
      env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), DIM_HOST_EXECUTABLE: endpoint, DIM_COPY_GUEST_ROOT: guest, DIM_COPY_READY_FILE: ready, TMPDIR: temporary },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.write(Buffer.alloc(128 * 1024, 7));
    await created(ready); child.kill("SIGINT");
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(status, 130); assert.deepEqual((await readdir(temporary)).filter((name) => name.startsWith("dim-copy-stdin-")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function command(root: string, guest: string, endpoint: string, bin: string, args: readonly string[], input: Buffer, cwd?: string) {
  const child = spawn(process.execPath, ["--conditions=dim-source", "--import", import.meta.resolve("tsx"), cli, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), DIM_HOST_EXECUTABLE: endpoint, DIM_COPY_GUEST_ROOT: guest, PATH: `${bin}:${process.env.PATH ?? ""}` },
    ...(cwd === undefined ? {} : { cwd }),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout: Buffer[] = []; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.stdin.end(input);
  const status = await closeWithin(child);
  return { status, stdout: Buffer.concat(stdout), stderr };
}

async function onceData(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => { stream.once("data", () => resolve()); stream.once("error", reject); });
}

async function closeWithin(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("copy process did not terminate")); }, 5000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => { clearTimeout(timer); resolve(status); });
  });
}

async function created(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = () => { if (!done) { done = true; watcher.close(); resolve(); } };
    const watcher = watch(path.dirname(file), (event, name) => { if (event === "rename" && name === path.basename(file)) finish(); });
    watcher.once("error", reject);
    void access(file).then(finish).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { watcher.close(); reject(error); }
    });
  });
}
