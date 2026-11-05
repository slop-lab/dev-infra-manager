import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

for (const layout of ["installed", "source"] as const) {
  for (const change of ["package version", "pinned dependency"] as const) {
    it(`invalidates an in-place ${layout} broker when its ${change} changes without changing broker code`, async () => {
      const root = await mkdtemp(join(tmpdir(), "dim-broker-runtime-upgrade-"));
      let child: ChildProcess | undefined;
      try {
        const directory = layout === "source" ? join(root, "src") : root;
        await mkdir(directory, { recursive: true });
        const runtime = join(directory, layout === "installed" ? "nativeWorkspaceBrokerRuntime.mjs" : "nativeWorkspaceBrokerRuntime.ts");
        await copyFile(new URL("../../../../packages/host/plugins/native-git/src/nativeWorkspaceBrokerRuntime.ts", import.meta.url), runtime);
        const broker = join(directory, layout === "installed" ? "nativeWorkspaceBroker.js" : "nativeWorkspaceBroker.ts");
        await writeFile(broker, "export const unchangedBroker = true;\n");
        const manifest = { name: "@slop-lab/dim-host-plugin-native-git", version: "0.10.0-local-before", type: "module",
          dependencies: { "@slop-lab/dim-contracts-git": "0.10.0-local-before" } };
        const file = join(root, "package.json");
        await writeFile(file, JSON.stringify(manifest));
        const initialDirectory = await stat(directory), initialBroker = await readFile(broker);
        const load = `const {nativeWorkspaceBrokerRuntimeRevision:revision}=await import(${JSON.stringify(pathToFileURL(runtime).href)});`;
        // Keep an actual Node process resident across replacement, as a detached
        // workspace broker remains resident during a host package upgrade.
        child = spawn(process.execPath, ["--input-type=module", "-e", `${load}process.on('message',()=>process.send(revision));process.send(revision);`],
          { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        const [oldRevision] = await once(child, "message");
        expect(oldRevision).toMatch(/^[a-f0-9]{64}$/);
        if (change === "package version") manifest.version = "0.10.0-local-after";
        else manifest.dependencies["@slop-lab/dim-contracts-git"] = "0.10.0-local-after";
        await writeFile(file, JSON.stringify(manifest));
        const currentDirectory = await stat(directory);
        expect([currentDirectory.dev, currentDirectory.ino]).toEqual([initialDirectory.dev, initialDirectory.ino]);
        expect(await readFile(broker)).toEqual(initialBroker);
        const residentResponse = once(child, "message");
        child.send("health");
        expect((await residentResponse)[0]).toBe(oldRevision);
        const installedRevision = execFileSync(process.execPath, ["--input-type=module", "-e", `${load}console.log(revision);`], { encoding: "utf8", timeout: 5000 }).trim();
        expect(installedRevision).toMatch(/^[a-f0-9]{64}$/);
        expect(installedRevision).not.toBe(oldRevision);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit"); child.kill(); await exited;
        }
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
