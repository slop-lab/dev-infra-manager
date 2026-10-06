import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { installControlPlane } from "./controlPlaneInstall.js";
import { defaultControlPlaneStateRoot } from "./controlPlaneState.js";
import { printInstallControlPlaneHelp } from "./installerHelp.js";

export async function installControlPlaneCommand(commandArgs: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args: commandArgs,
    allowPositionals: false,
    strict: true,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (parsed.values.help) return printInstallControlPlaneHelp();
  const configOccurrences = commandArgs.filter((value) => value === "--config" || value.startsWith("--config=")).length;
  if (configOccurrences !== 1 || parsed.values.config === undefined) {
    throw new Error("installer install control-plane requires exactly one --config FILE");
  }
  if (!isAbsolute(parsed.values.config)) throw new Error("--config FILE must be an absolute path");

  const installed = await installControlPlane({
    configPath: parsed.values.config,
    stateRoot: defaultControlPlaneStateRoot()
  });
  console.log(`Installed control-plane generation ${installed.record.generationId}`);
  console.log("Services: native-git, ordinary-ci");
}
