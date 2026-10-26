import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OperationsConfig } from "./operations.js";
import type { WebPluginContext } from "./plugin-api.js";
import { maximumHostOutputBytes } from "./host-output.js";
import { HttpResponseError } from "./http-response.js";
const execute = promisify(execFile);
/** This is a server-side capability for reviewed plugins, never a browser RPC. */
export function webPluginContext(hosts: OperationsConfig["hosts"] = []): WebPluginContext {
  return Object.freeze({ controllers: Object.freeze(hosts.map(({ id, executable, selector }) => Object.freeze({ id,
    async run(args: readonly string[], options?: { readonly timeoutMilliseconds: number; readonly input?: string }): Promise<unknown> {
      const timeout = options === undefined ? 30_000 : options?.timeoutMilliseconds;
      if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).some((key) => key !== "timeoutMilliseconds" && key !== "input"))
        || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 180_000) throw new Error("invalid controller command timeout");
      if (options?.input !== undefined && (typeof options.input !== "string" || Buffer.byteLength(options.input, "utf8") > 128 * 1024)) throw new Error("invalid controller command input");
      if (!Array.isArray(args) || args.length === 0 || args.length > 128 || typeof args[0] !== "string" || args[0].startsWith("-")
        || args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > 96 * 1024 || arg.includes("\0") || /^(?:--host|--json)(?:=|$)/.test(arg))
        || args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg, "utf8"), 0) > 128 * 1024) throw new Error("invalid controller command arguments");
      try {
        const execution = execute(executable, ["--host", selector, ...args, "--json"], {
          timeout, maxBuffer: maximumHostOutputBytes, encoding: "utf8", windowsHide: true
        });
        execution.child.stdin?.on("error", () => { /* A command may close stdin before consuming all input. */ });
        execution.child.stdin?.end(options?.input ?? "");
        const result = await execution;
        return JSON.parse(result.stdout) as unknown;
      } catch { throw new HttpResponseError(502, "The selected host command is unavailable or returned an invalid response. It may have completed; refresh its state before retrying.", "host_result_unavailable"); }
    }
  }))) });
}
