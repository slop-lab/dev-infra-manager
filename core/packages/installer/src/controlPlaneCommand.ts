import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { installControlPlane, rollForwardControlPlane } from "./controlPlaneInstall.js";
import { defaultControlPlaneStateRoot } from "./controlPlaneState.js";
import { printInstallControlPlaneHelp, printRecoverControlPlaneHelp } from "./installerHelp.js";

const generationPattern = /^[0-9a-f]{64}$/;

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

export async function recoverControlPlaneCommand(commandArgs: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args: commandArgs,
    allowPositionals: false,
    strict: true,
    options: {
      "roll-forward": { type: "boolean" },
      generation: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (parsed.values.help) return printRecoverControlPlaneHelp();
  const rollForwardOccurrences = commandArgs.filter((value) => value === "--roll-forward").length;
  const generationOccurrences = commandArgs.filter((value) => value === "--generation" || value.startsWith("--generation=")).length;
  if (rollForwardOccurrences !== 1 || parsed.values["roll-forward"] !== true) {
    throw new Error("installer recover control-plane requires exactly one --roll-forward");
  }
  if (generationOccurrences !== 1 || parsed.values.generation === undefined
    || !generationPattern.test(parsed.values.generation)) {
    throw new Error("installer recover control-plane requires exactly one canonical --generation GENERATION");
  }
  const installed = await rollForwardControlPlane({
    stateRoot: defaultControlPlaneStateRoot(),
    expectedGenerationId: parsed.values.generation
  });
  console.log(`Recovered control-plane generation ${installed.record.generationId}`);
  console.log("Services: native-git, ordinary-ci");
}
