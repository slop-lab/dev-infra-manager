import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export interface HostProtocolSupport { readonly protocol: "dim.cli-host"; readonly versions: readonly number[] }
/** Release versions are independent. Only the deliberately small wire protocol is negotiated. */
export async function queryHostProtocol(executable: string): Promise<HostProtocolSupport> {
  const result = await execute(executable, ["--host-protocol"], { timeout: 10_000, maxBuffer: 16 * 1024 });
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("protocol" in value) || value.protocol !== "dim.cli-host" || !("versions" in value) || !Array.isArray(value.versions)
    || value.versions.length === 0 || value.versions.some((entry: unknown) => !Number.isSafeInteger(entry) || Number(entry) < 1)
    || new Set(value.versions).size !== value.versions.length) throw new Error("invalid DIM CLI/host protocol support; install a compatible CLI and host runtime");
  return { protocol: "dim.cli-host", versions: value.versions };
}
export async function assertHostProtocolCompatible(host: string, cli: string): Promise<void> {
  const [hostSupport, cliSupport] = await Promise.all([queryHostProtocol(host), queryHostProtocol(cli)]);
  if (!hostSupport.versions.some((version) => cliSupport.versions.includes(version))) throw new Error("DIM CLI and host protocol versions are incompatible; install a compatible CLI before replacing the host");
}
