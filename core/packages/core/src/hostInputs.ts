import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UserError } from "./errors.js";
import { DIM_PLUGIN_API_VERSION, type DimPlugin, type HostInputRequest } from "./plugin.js";

const execFileAsync = promisify(execFile);

async function gitAuthor(request: HostInputRequest): Promise<string> {
  if (request.parameters !== undefined) {
    throw new UserError("builtin.git-author does not accept parameters");
  }
  const configKey = request.key === "name"
    ? "user.name"
    : request.key === "email"
      ? "user.email"
      : undefined;
  if (!configKey) throw new UserError(`unsupported builtin.git-author key '${request.key}'`);
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", configKey]);
    const value = stdout.trim();
    if (!value) throw new Error("empty value");
    return value;
  } catch {
    throw new UserError(`host input 'builtin.git-author/${request.key}' is unavailable`);
  }
}

export const builtInHostInputPlugin: DimPlugin = {
  name: "builtin.host-inputs",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    host.registerHostInputProvider("builtin.git-author", { resolve: gitAuthor });
  }
};
