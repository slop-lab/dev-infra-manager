import { pipeline } from "node:stream/promises";
import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "transport-probe",
  commands: [{ name: "transport-probe", description: "Test-owned argument and byte-stream boundary" }],
  async run(args) {
    if (args[1] === "bytes") { await pipeline(process.stdin, process.stdout); process.exitCode = 37; }
    else process.stdout.write(JSON.stringify(args.slice(1)));
  }
};
