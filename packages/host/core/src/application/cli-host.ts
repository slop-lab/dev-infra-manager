import { cliHostProtocol, cliHostVersion, decodeHostRequest, type HostRequest as CliHostRequest } from "@slop-lab/dim-contracts-cli-host";
import { UserError } from "../errors.js";

export function hostProtocolCapabilities() { return { protocol: cliHostProtocol, versions: [cliHostVersion] }; }

/** Decode the versioned envelope before loading any plugin or executing a
 * command. The only exposed record shape is a transport endpoint identity. */
export async function runCliHostRequest(encoded: string): Promise<void> {
  const request: CliHostRequest = decodeHostRequest(encoded);
  switch (request.operation) {
    case "capabilities": process.stdout.write(`${JSON.stringify(hostProtocolCapabilities())}\n`); return;
    case "command": {
      const { runHostCommand } = await import("./commands/index.js");
      await runHostCommand(request.input.args); return;
    }
    case "workspace.endpoint": {
      const { executeHostOperation } = await import("./host-application.js");
      const workspace = await executeHostOperation({ operation: "show", input: { name: request.input.name } });
      if (!workspace || typeof workspace !== "object" || !("id" in workspace) || typeof workspace.id !== "string" || !("runtimeStatus" in workspace) || !["running", "stopped", "missing", "unavailable"].includes(String(workspace.runtimeStatus))) throw new UserError("Invalid workspace endpoint state");
      process.stdout.write(`${JSON.stringify({ workspaceId: workspace.id, runtimeStatus: workspace.runtimeStatus === "unavailable" ? "unknown" : workspace.runtimeStatus })}\n`);
      return;
    }
    case "workspace.connect": {
      const { executeHostOperation } = await import("./host-application.js");
      await executeHostOperation({ operation: "connect", input: request.input });
    }
  }
}
