import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const client = fileURLToPath(new URL("../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));

async function processIsLive(pid: number): Promise<boolean> {
  try {
    const snapshot = await readFile(`/proc/${pid}/stat`, "utf8");
    return snapshot.slice(snapshot.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "ENOENT")) return false;
    throw error;
  }
}

it("service removal retries owner metadata replaced while it is being opened", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-service-remove-owner-"));
  const env = { ...process.env, HOME: home };
  const run = (...args: string[]) => execute(process.execPath, [client, ...args], { cwd: home, env });
  let supervisor = 0, child = 0;
  try {
    await run("service", "register", "--name", "worker", "--", process.execPath, "-e", "setInterval(()=>{},1000)");
    await run("service", "resume");
    const owner = path.join(home, ".local/state/dim/services/worker.lock/owner.json");
    ({ pid: supervisor, child } = JSON.parse(await readFile(owner, "utf8")));
    const replaced = path.join(home, "replaced");
    const preload = path.join(home, "replace-owner.cjs");
    await writeFile(preload, `
const fs = require('node:fs/promises');
const originalOpen = fs.open;
let replaced = false;
fs.open = async function(file, ...args) {
  const handle = await originalOpen.call(this, file, ...args);
  if (file === ${JSON.stringify(owner)} && !replaced) {
    replaced = true;
    const value = await fs.readFile(file);
    await fs.writeFile(file + '.replacement', value, { mode: 0o600, flag: 'wx' });
    await fs.rename(file + '.replacement', file);
    await fs.writeFile(${JSON.stringify(replaced)}, 'done');
  }
  return handle;
};
require('node:module').syncBuiltinESMExports();
`);
    await execute(process.execPath, ["--require", preload, client, "service", "remove", "worker"], { cwd: home, env });
    expect(await readFile(replaced, "utf8")).toBe("done");
    await expect.poll(() => processIsLive(supervisor)).toBe(false);
    await expect.poll(() => processIsLive(child)).toBe(false);
  } finally {
    if (supervisor && await processIsLive(supervisor)) process.kill(supervisor, "SIGKILL");
    if (child && await processIsLive(child)) process.kill(child, "SIGKILL");
    await run("service", "remove", "worker").catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});
