import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerRecord } from "../../.dim/qemu-service-owner.mjs";
import { captureSocketIdentity, createSocketLease, publishOwner } from "../../.dim/qemu-service-artifacts.mjs";
import { createServer, type Server } from "node:net";

const ownerModule = pathToFileURL(resolve(import.meta.dirname, "../../.dim/qemu-service-owner.mjs")).href;
const artifactModule = pathToFileURL(resolve(import.meta.dirname, "../../.dim/qemu-service-artifacts.mjs")).href;
const roots: string[] = [];
const servers: Server[] = [];

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-owner-descriptor-test-"));
  roots.push(root);
  const socketPath = resolve(root, "service.sock");
  const ownerPath = resolve(root, "service-owner.json");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  await createSocketLease(socketPath, await captureSocketIdentity(socketPath));
  return { ownerPath, root, socketPath };
}

async function harness(root: string, body: string) {
  const loader = resolve(root, "loader.mjs");
  const wrapper = resolve(root, "fs-wrapper.mjs");
  const runner = resolve(root, "runner.mjs");
  await writeFile(loader, `import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs/promises" && (context.parentURL?.startsWith(${JSON.stringify(ownerModule)}) || context.parentURL?.startsWith(${JSON.stringify(artifactModule)})))
    return { shortCircuit: true, url: pathToFileURL(process.env.DIM_TEST_FS_WRAPPER).href };
  return nextResolve(specifier, context);
}`);
  await writeFile(wrapper, `import * as fs from "node:fs/promises";
export const readFile=fs.readFile,realpath=fs.realpath,rename=fs.rename,rm=fs.rm,stat=fs.stat;
let rebound=false;
export async function open(path,...args){const handle=await fs.open(path,...args);if(path===process.env.DIM_TEST_OWNER&&!rebound){rebound=true;await fs.rename(process.env.DIM_TEST_REPLACEMENT,path)}return handle}
export async function lstat(path,...args){const value=await fs.lstat(path,...args);if(path===process.env.DIM_TEST_OWNER&&!rebound){rebound=true;await fs.rename(process.env.DIM_TEST_REPLACEMENT,path)}return value}
export async function link(source,destination){await fs.link(source,destination);if(destination===process.env.DIM_TEST_OWNER){await fs.rename(process.env.DIM_TEST_REPLACEMENT,source)} }
`);
  await writeFile(runner, body);
  return { loader, runner, wrapper };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU owner descriptor binding", () => {
  it("reads and identifies the owner through the descriptor opened before pathname rebinding", async () => {
    const paths = await fixture();
    await publishOwner(paths.ownerPath, await createOwnerRecord(paths.socketPath));
    const replacement = resolve(paths.root, "replacement-owner");
    await writeFile(replacement, "not-json\n");
    const files = await harness(paths.root, `import { inspectOwner } from ${JSON.stringify(ownerModule)};
const result=await inspectOwner(process.env.DIM_TEST_OWNER,process.env.DIM_TEST_SOCKET,process.cwd());
process.stdout.write(result.state);`);
    const result = spawnSync(process.execPath, ["--experimental-loader", files.loader, files.runner], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DIM_TEST_FS_WRAPPER: files.wrapper,
        DIM_TEST_OWNER: paths.ownerPath, DIM_TEST_REPLACEMENT: replacement, DIM_TEST_SOCKET: paths.socketPath }
    });
    expect.soft(result.status).toBe(0);
    expect.soft(result.stdout).toBe("live");
    expect(await readFile(paths.ownerPath, "utf8")).toBe("not-json\n");
  });

  it("returns temporary-handle identity and preserves a replacement temporary path", async () => {
    const paths = await fixture();
    const record = await createOwnerRecord(paths.socketPath);
    const replacement = resolve(paths.root, "replacement-owner");
    await writeFile(replacement, "replacement\n");
    const files = await harness(paths.root, `import { lstat,readFile } from "node:fs/promises";
import { publishOwner } from ${JSON.stringify(artifactModule)};
const identity=await publishOwner(process.env.DIM_TEST_OWNER,JSON.parse(process.env.DIM_TEST_RECORD));
const names=(await import("node:fs/promises")).readdir(process.env.DIM_TEST_ROOT);
const temporary=(await names).find(name=>name.startsWith(".service-owner.json."));
const published=await lstat(process.env.DIM_TEST_OWNER,{bigint:true});
process.stdout.write(JSON.stringify({identity,temporary,content:await readFile(process.env.DIM_TEST_ROOT+"/"+temporary,"utf8"),inode:published.ino.toString()}));`);
    const result = spawnSync(process.execPath, ["--experimental-loader", files.loader, files.runner], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DIM_TEST_FS_WRAPPER: files.wrapper,
        DIM_TEST_OWNER: paths.ownerPath, DIM_TEST_RECORD: JSON.stringify(record),
        DIM_TEST_REPLACEMENT: replacement, DIM_TEST_ROOT: paths.root }
    });
    expect.soft(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { content: string; identity: { inode: string }; inode: string };
    expect.soft(output.identity.inode).toBe(output.inode);
    expect(output.content).toBe("replacement\n");
  });
});