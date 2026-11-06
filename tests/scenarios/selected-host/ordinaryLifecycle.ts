import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult } from "../web-lifecycle/process.js";
import { OperatorInputError, type OwnedWorkspace } from "./config.js";
import { guestNestedData } from "./nestedData.js";

export type OrdinaryRuntimeVersions = { readonly node: string; readonly kernel: string; readonly nestedDocker: string; readonly image: string };

export async function verifyOrdinaryLifecycle(input: {
  readonly workspace: OwnedWorkspace;
  readonly run: (step: string, args: readonly string[], timeout?: number) => Promise<CommandResult>;
}): Promise<OrdinaryRuntimeVersions> {
  const { workspace, run } = input;
  const root = await mkdtemp(path.join(tmpdir(), "dim-selected-copy-"));
  const source = path.join(root, "input.bin"), destination = path.join(root, "output.bin"), payload = Buffer.from([0, 255, 1, 10, 128]);
  try {
    await writeFile(source, payload, { mode: 0o600 });
    await run("ordinary binary upload", ["cp", source, `${workspace.name}:selected-host-copy.bin`]);
    await run("ordinary binary download", ["cp", `${workspace.name}:selected-host-copy.bin`, destination]);
    if (!(await readFile(destination)).equals(payload)) throw new OperatorInputError("selected-host binary copy changed bytes");
    await run("persistent home sentinel", ["exec", workspace.name, "--", "sh", "-eu", "-c", "printf home-retained > \"$HOME/selected-host-home.txt\""]);
    await run("private nested Docker data sentinel", ["exec", workspace.name, "--", "node", "-e", guestNestedData, "write", workspace.id, "nested-retained"]);
    await run("workspace resource update", ["resources", workspace.name, "--expect-id", workspace.id, "--cpus", "1", "--memory", "2g", "--pids", "1024", "--json"]);
    for (const operation of ["stop", "start", "start", "restart"] as const) {
      const result = await run(`ordinary ${operation}`, [operation, workspace.name, "--expect-id", workspace.id, "--json"], 180_000);
      const record: unknown = JSON.parse(result.stdout);
      if (!record || typeof record !== "object" || !("id" in record) || record.id !== workspace.id) throw new OperatorInputError("ordinary lifecycle changed immutable workspace identity");
    }
    const retained = await run("persistent home after restart", ["exec", workspace.name, "--", "cat", "/home/dim/selected-host-home.txt"]);
    if (retained.stdout !== "home-retained") throw new OperatorInputError("workspace restart did not retain home data");
    await run("private nested Docker data after restart", ["exec", workspace.name, "--", "node", "-e", guestNestedData, "read", workspace.id, "nested-retained"]);
    await run("retained binary after restart", ["cp", "--overwrite", `${workspace.name}:selected-host-copy.bin`, destination]);
    if (!(await readFile(destination)).equals(payload)) throw new OperatorInputError("workspace restart did not retain checkout data");
    const shown: unknown = JSON.parse((await run("ordinary resource readback", ["show", workspace.name, "--json"])).stdout);
    if (!shown || typeof shown !== "object" || !("resources" in shown) || !shown.resources || typeof shown.resources !== "object"
      || !("cpuCount" in shown.resources) || shown.resources.cpuCount !== "1" || !("memory" in shown.resources) || shown.resources.memory !== "2g"
      || !("pidsLimit" in shown.resources) || shown.resources.pidsLimit !== "1024") throw new OperatorInputError("resource readback differs from requested limits");
    if (!("image" in shown) || typeof shown.image !== "string") throw new OperatorInputError("workspace image readback is unavailable");
    const versions = { image: shown.image, node: (await run("guest Node version", ["exec", workspace.name, "--", "node", "--version"])).stdout.trim(),
      kernel: (await run("guest kernel version", ["exec", workspace.name, "--", "uname", "-r"])).stdout.trim(),
      nestedDocker: (await run("private Docker version", ["exec", workspace.name, "--", "docker", "version", "--format", "{{.Server.Version}}"])).stdout.trim() };
    if (!/^v(?:24|26)\.\d+\.\d+$/.test(versions.node) || !/^\d+\.\d+[a-zA-Z0-9.+_-]*$/.test(versions.kernel)
      || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/.test(versions.nestedDocker)) throw new OperatorInputError("runtime version probes returned unsupported or unreadable metadata");
    return versions;
  } finally { await rm(root, { recursive: true, force: true }); }
}
