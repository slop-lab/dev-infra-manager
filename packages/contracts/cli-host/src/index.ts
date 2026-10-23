/** Wire version 1 is independent of package and host release versions. */
export const cliHostProtocol = "dim.cli-host" as const;
export const cliHostVersion = 1 as const;

export class CliHostProtocolError extends Error {
  readonly exitCode = 2;
}

interface Inputs {
  capabilities: Record<string, never>;
  command: { readonly args: readonly string[]; readonly terminal?: boolean };
  "workspace.endpoint": { readonly name: string };
  "workspace.connect": { readonly name: string; readonly port: number; readonly workspaceId: string };
}
export type HostOperation = keyof Inputs;
export type HostRequest = { [K in HostOperation]: {
  readonly protocol: typeof cliHostProtocol;
  readonly version: typeof cliHostVersion;
  readonly operation: K;
  readonly input: Inputs[K];
} }[HostOperation];
export interface CliHostCapabilities {
  readonly protocol: typeof cliHostProtocol;
  readonly versions: readonly number[];
}
export interface WorkspaceEndpoint {
  readonly workspaceId: string;
  readonly runtimeStatus: "running" | "stopped" | "missing" | "unknown";
}

export function createHostRequest<K extends HostOperation>(operation: K, input: Inputs[K]): HostRequest {
  return parseHostRequest({ protocol: cliHostProtocol, version: cliHostVersion, operation, input });
}
export function encodeHostRequest(request: HostRequest): string {
  return Buffer.from(JSON.stringify(parseHostRequest(request)), "utf8").toString("base64url");
}
export function decodeHostRequest(encoded: string): HostRequest {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new CliHostProtocolError("Invalid DIM CLI/host request encoding");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new CliHostProtocolError("Invalid DIM CLI/host request JSON"); }
  return parseHostRequest(value);
}
export function parseHostRequest(value: unknown): HostRequest {
  if (!object(value) || value.protocol !== cliHostProtocol) throw new CliHostProtocolError("Invalid DIM CLI/host protocol");
  if (value.version !== cliHostVersion) throw new CliHostProtocolError("Unsupported DIM CLI/host protocol version; update the client or host");
  if (!object(value.input) || !keys(value, ["protocol", "version", "operation", "input"])) throw new CliHostProtocolError("Invalid DIM CLI/host request");
  const input = value.input;
  if (value.operation === "capabilities" && keys(input, [])) return { protocol: cliHostProtocol, version: cliHostVersion, operation: "capabilities", input: {} };
  if (value.operation === "command" && keys(input, ["args", "terminal"]) && Array.isArray(input.args)
    && input.args.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0"))
    && (input.terminal === undefined || typeof input.terminal === "boolean")) {
    return { protocol: cliHostProtocol, version: cliHostVersion, operation: "command", input: { args: input.args as string[], ...(input.terminal === undefined ? {} : { terminal: input.terminal }) } };
  }
  if (value.operation === "workspace.endpoint" && keys(input, ["name"]) && text(input.name)) {
    return { protocol: cliHostProtocol, version: cliHostVersion, operation: "workspace.endpoint", input: { name: input.name } };
  }
  if (value.operation === "workspace.connect" && keys(input, ["name", "port", "workspaceId"]) && text(input.name) && text(input.workspaceId)
    && typeof input.port === "number" && Number.isInteger(input.port) && input.port >= 1 && input.port <= 65535) {
    return { protocol: cliHostProtocol, version: cliHostVersion, operation: "workspace.connect", input: { name: input.name, port: input.port, workspaceId: input.workspaceId } };
  }
  throw new CliHostProtocolError("Invalid DIM CLI/host operation or input");
}
export function parseCapabilities(value: unknown): CliHostCapabilities {
  if (!object(value) || value.protocol !== cliHostProtocol || !Array.isArray(value.versions)
    || !value.versions.length || !value.versions.every((version: unknown) => typeof version === "number" && Number.isSafeInteger(version) && version > 0)) throw new CliHostProtocolError("Host returned invalid CLI/host capabilities");
  return { protocol: cliHostProtocol, versions: value.versions as number[] };
}
export function parseWorkspaceEndpoint(value: unknown): WorkspaceEndpoint {
  if (!object(value) || !text(value.workspaceId) || !["running", "stopped", "missing", "unknown"].includes(String(value.runtimeStatus))) throw new CliHostProtocolError("Host returned an invalid workspace endpoint");
  return { workspaceId: value.workspaceId, runtimeStatus: value.runtimeStatus as WorkspaceEndpoint["runtimeStatus"] };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0"); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
