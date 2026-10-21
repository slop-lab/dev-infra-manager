import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OperationsConfig } from "./operations.js";
import type { WebPluginContext } from "./plugin-api.js";
const execute = promisify(execFile);
/** This is a server-side capability for reviewed plugins, never a browser RPC. */
export function webPluginContext(hosts: OperationsConfig["hosts"] = []): WebPluginContext {
  return Object.freeze({ controllers: Object.freeze(hosts.map(({ id, executable, selector }) => Object.freeze({ id,
    async run(args: readonly string[], options?: { readonly timeoutMilliseconds: number }): Promise<unknown> {
      const timeout = options === undefined ? 30_000 : options?.timeoutMilliseconds;
      if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).some((key) => key !== "timeoutMilliseconds"))
        || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 180_000) throw new Error("invalid controller command timeout");
      if (!Array.isArray(args) || args.length === 0 || args.length > 128 || typeof args[0] !== "string" || args[0].startsWith("-")
        || args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > 96 * 1024 || arg.includes("\0") || /^(?:--host|--json)(?:=|$)/.test(arg))
        || args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg, "utf8"), 0) > 128 * 1024) throw new Error("invalid controller command arguments");
      try {
        const result = await execute(executable, ["--host", selector, ...args, "--json"], {
          timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true
        });
        return JSON.parse(result.stdout) as unknown;
      } catch { throw new Error("The selected controller command is unavailable or returned an invalid response"); }
    }
  }))) });
}
