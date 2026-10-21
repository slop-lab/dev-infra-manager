import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OperationsConfig } from "./operations.js";
import type { WebPluginContext } from "./plugin-api.js";
const execute = promisify(execFile);
/** This is a server-side capability for reviewed plugins, never a browser RPC. */
export function webPluginContext(hosts: OperationsConfig["hosts"] = []): WebPluginContext {
  return Object.freeze({ controllers: Object.freeze(hosts.map(({ id, executable, selector }) => Object.freeze({ id,
    async run(args: readonly string[]): Promise<unknown> {
      if (!Array.isArray(args) || args.length === 0 || args.length > 128 || typeof args[0] !== "string" || args[0].startsWith("-")
        || args.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0") || /^(?:--host|--json)(?:=|$)/.test(arg))
        || args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg, "utf8"), 0) > 32 * 1024) throw new Error("invalid controller command arguments");
      try {
        const result = await execute(executable, ["--host", selector, ...args, "--json"], {
          timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true
        });
        return JSON.parse(result.stdout) as unknown;
      } catch { throw new Error("The selected controller command is unavailable or returned an invalid response"); }
    }
  }))) });
}
