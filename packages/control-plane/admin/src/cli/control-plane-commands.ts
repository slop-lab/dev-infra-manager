import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveControlPlaneSelection, reconnectNativeWorkspaces } from "@slop-lab/dim-host-plugin-native-git";
import { registerCiCommands } from "./ci-commands.js";
import type { Command } from "commander";
import { prepareControlPlane, connectControlPlane } from "../controlPlaneSetup.js";

export function registerControlPlaneCommands(program: Command): void {
  const command = program.command("control-plane").description("Prepare optional native Git and shared execution services");
  command.command("prepare")
    .description("Create private deployment configuration in a new directory")
    .argument("<directory>")
    .requiredOption("--native-git-image <digest-reference>", "reviewed native Git service image")
    .requiredOption("--execution-image <digest-reference>", "reviewed execution scheduler image")
    .option("--host-id <name>", "initial operator host ID", "operator")
    .option("--native-git-port <port>", "loopback native Git port", "8787")
    .option("--execution-port <port>", "loopback execution scheduler port", "8788")
    .option("--execution-worker <id>", "prepare one initial authenticated execution worker")
    .option("--ci-container-slots <count>", "number of Sysbox slots", "0")
    .option("--ci-vm-slots <count>", "number of KVM QEMU slots", "0")
    .option("--ci-runner-image <digest-reference>", "reviewed Sysbox supervisor image")
    .option("--ci-job-image <digest-reference>", "reviewed Sysbox job environment image")
    .option("--ci-container-profile <file>", "advanced Sysbox execution profile, instead of image flags")
    .option("--ci-vm-profile <file>", "reviewed QEMU execution profile")
    .action(async (directory: string, flags: { nativeGitImage: string; executionImage: string; hostId: string;
      nativeGitPort: string; executionPort: string; executionWorker?: string; ciContainerSlots: string; ciVmSlots: string;
      ciRunnerImage?: string; ciJobImage?: string; ciContainerProfile?: string; ciVmProfile?: string }) => {
      const prepared = await prepareControlPlane({ directory, ...flags,
        nativeGitPort: Number(flags.nativeGitPort), executionPort: Number(flags.executionPort),
        ciContainerSlots: Number(flags.ciContainerSlots), ciVmSlots: Number(flags.ciVmSlots),
        ciContainerProfile: flags.ciContainerProfile === undefined ? undefined : JSON.parse(await readFile(flags.ciContainerProfile, "utf8")),
        ciVmProfile: flags.ciVmProfile === undefined ? undefined : JSON.parse(await readFile(flags.ciVmProfile, "utf8")) });
      console.log(`Prepared ${prepared.configFile}`);
      console.log("No services were installed. Review the generated files, then run:");
      console.log(`dim installer install control-plane --config ${quote(prepared.configFile)}`);
      console.log(`dim control-plane connect ${quote(directory)}`);
      if (flags.executionWorker !== undefined) console.log("Connecting will write private worker.json; capacity starts only when you run the printed worker command.");
    });
  command.command("connect")
    .description("Verify the live generation and write private host/bootstrap connections")
    .argument("<directory>")
    .option("--host-id <id>", "existing configured host authority to export")
    .option("--no-select", "export connections without changing this controller's selection")
    .option("--endpoint <loopback-origin>", "SSH-forwarded native Git endpoint")
    .option("--execution-endpoint <origin>", "Execution service endpoint, for a separate SSH loopback forward")
    .option("--output-directory <directory>", "new connection directory, useful after a service upgrade")
    .option("--execution-worker-state-directory <absolute-path>", "worker-owned state path on the host that will run the prepared worker")
    .action(async (directory: string, flags: { hostId?: string; select?: boolean; endpoint?: string; executionEndpoint?: string; outputDirectory?: string; executionWorkerStateDirectory?: string }) => {
      const connected = await connectControlPlane(directory, flags);
      if (flags.select !== false) await saveControlPlaneSelection({ hostConnectionFile: path.join(connected.directory, "host.json"),
        importerConnectionFile: path.join(connected.directory, "importer.json") });
      const reconnected = flags.select !== false ? await reconnectNativeWorkspaces() : 0;
      console.log(`Connected host ${connected.hostId} to generation ${connected.generationId}`);
      console.log(`Private connections: ${connected.directory}`);
      console.log(flags.select === false ? "Exported connections; this controller's selection was not changed." : "Selected this control plane for native Project and workspace commands on this host.");
      if (reconnected) console.log(`Reconnected ${reconnected} existing workspace Git brokers without restarting guests.`);
      if (connected.workerConfigFile !== undefined) {
        console.log("Execution capacity is configured but no worker was started. Run on the selected worker host:");
        console.log(`dim execution worker ${quote(connected.workerConfigFile)}`);
      } else if (connected.executionWorkerCount > 1) {
        console.log("Several execution workers are configured; generate each host's private worker configuration explicitly. No worker.json was selected.");
      }
      console.log("Create a Project with 'dim project create NAME', then import each repository with 'dim project repository import NAME REPOSITORY --source PATH --ref REF --policy FILE'.");
    });
  registerCiCommands(command);
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
