import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureLocalImageRegistry, registryClaims } from "../../../scripts/local-control-plane/registry.ts";
import { retainedCacheData } from "../../../scripts/local-uninstall/cache-data.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
import type { DockerResource } from "../../../scripts/local-uninstall/docker.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const id = "11111111-1111-4111-8111-111111111111";
it("starts only the recorded registry, preserves its data volume, and checks loopback readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-local-registry-")); roots.push(root);
  const directory = join(root, "local-install"); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "registry.json"), JSON.stringify({ schemaVersion: 1, id }), { mode: 0o600 });
  const server = createServer((_req, response) => { response.writeHead(200); response.end("{}"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const [container, volume] = registryClaims({ schemaVersion: 1, id });
  const calls: string[][] = [];
  const run: Command = async (_file, args) => {
    calls.push([...args]);
    let value: unknown = "";
    if (args[1] === "ls") value = `${args[0] === "volume" ? volume!.name : container!.name}\n`;
    else if (args[0] === "inspect") value = JSON.stringify({ "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] });
    else if (args[0] === "volume") value = JSON.stringify([{ Labels: volume!.labels }]);
    else if (args[1] === "inspect") value = JSON.stringify([{ Id: "owned-container", State: { Running: false },
      Config: { Image: "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33", Labels: container!.labels },
      HostConfig: { Privileged: false, NetworkMode: "default", PortBindings: { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
      Mounts: [{ Name: volume!.name, Destination: "/var/lib/registry" }] }]);
    return { status: 0, stdout: String(value), stderr: "" };
  };
  try {
    expect(await ensureLocalImageRegistry(root, run)).toBe(`127.0.0.1:${port}`);
    expect(calls).toContainEqual(["container", "start", "owned-container"]);
    expect(calls.some((args) => args.includes("rm") || args.includes("create") || args.includes("run"))).toBe(false);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
});
it("refuses foreign named resources before starting or replacing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-local-registry-foreign-")); roots.push(root);
  const calls: string[][] = [];
  const run: Command = async (_file, args) => {
    calls.push([...args]);
    const ledger = JSON.parse(await readFile(join(root, "local-install/registry.json"), "utf8"));
    return { status: 0, stderr: "", stdout: args[1] === "ls" ? registryClaims(ledger)[1]!.name : JSON.stringify([{ Labels: {} }]) };
  };
  await expect(ensureLocalImageRegistry(root, run)).rejects.toThrow("foreign");
  expect(calls.every((args) => args[1] === "ls" || args[1] === "inspect")).toBe(true);
});
it("keeps the registry volume with its identity when cache retention is selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-local-registry-retain-")); roots.push(root);
  const paths = removalPaths({ HOME: root });
  const resources = registryClaims({ schemaVersion: 1, id }).map((claim) => ({ claim, id: claim.name, created: "today" })) as DockerResource[];
  expect(await retainedCacheData(paths, resources)).toEqual({ files: [join(paths.data, "local-install/registry.json")], volumes: [registryClaims({ schemaVersion: 1, id })[1]!.name] });
});
