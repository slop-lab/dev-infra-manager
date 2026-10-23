import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** Test-owned executable boundary: the client never resolves a host package. */
export async function hostExecutable(directory: string, published = false, nodeArguments: readonly string[] = []): Promise<string> {
  const entry = fileURLToPath(new URL(published ? "../../packages/host/core/dist/application/host-main.js" : "../../packages/host/core/src/application/host-main.ts", import.meta.url));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const args = [process.execPath, "--disable-warning=DEP0205", ...(published ? [] : ["--conditions=dim-source", "--import", createRequire(import.meta.url).resolve("tsx")]), ...nodeArguments, entry];
  const executable = path.join(directory, nodeArguments.length ? `dim-host-endpoint-${randomUUID()}` : "dim-host-endpoint");
  await writeFile(executable, `#!/bin/sh\nexec ${args.map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
  return executable;
}
