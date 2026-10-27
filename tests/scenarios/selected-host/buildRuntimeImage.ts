import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function buildRuntimeFixtureImage(): Promise<{ readonly image: string; readonly owner: string; readonly nodeSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-stdio-image-")), owner = randomUUID();
  try {
    const files = new Set([process.execPath, "/sbin/ip"]);
    for (const executable of [process.execPath, "/sbin/ip"]) {
      const { stdout } = await run("ldd", [executable], { timeout: 10_000 });
      for (const match of stdout.matchAll(/\/(?:usr\/)?lib(?:64)?\/[^\s()]+/g)) files.add(match[0]);
    }
    for (const file of files) {
      if (file.includes("..") || !file.startsWith("/")) throw new Error("fixture library path is not canonical");
      const destination = join(root, "root", file);
      await mkdir(dirname(destination), { recursive: true }); await copyFile(file, destination);
    }
    await writeFile(join(root, "Dockerfile"), `FROM scratch\nCOPY root/ /\nENV HOME=/tmp TMPDIR=/tmp PATH=${dirname(process.execPath)}:/usr/bin:/usr/sbin:/sbin:/bin\nLABEL dev.dim.test.fixture=${owner}\nENTRYPOINT [${JSON.stringify(process.execPath)}]\n`);
    const { stdout } = await run("docker", ["build", "--network", "none", "--quiet", root], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const image = stdout.trim().split("\n").at(-1);
    if (!image || !/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error("fixture build did not return an immutable image identity");
    return { image, owner, nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex") };
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await buildRuntimeFixtureImage())}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "runtime fixture image build failed"}\n`); process.exitCode = 1; }
}
