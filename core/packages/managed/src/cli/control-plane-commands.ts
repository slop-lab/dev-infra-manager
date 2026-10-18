import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveControlPlaneSelection } from "../controlPlaneSelection.js";
import type { Command } from "commander";
import { prepareControlPlane, connectControlPlane } from "../controlPlaneSetup.js";

export function registerControlPlaneCommands(program: Command): void {
  const command = program.command("control-plane").description("Prepare optional native Git and shared CI services");
  command.command("prepare")
    .description("Create private deployment configuration in a new directory")
    .argument("<directory>")
    .requiredOption("--native-git-image <digest-reference>", "reviewed native Git service image")
    .requiredOption("--ordinary-ci-image <digest-reference>", "reviewed ordinary CI service image")
    .option("--host-id <name>", "initial operator host ID", "operator")
    .option("--native-git-port <port>", "loopback native Git port", "8787")
    .option("--ordinary-ci-port <port>", "loopback ordinary CI port", "8788")
    .option("--ci-worker <id>", "prepare one initial authenticated CI worker")
    .option("--ci-sysbox-slots <count>", "number of Sysbox slots", "0")
    .option("--ci-qemu-slots <count>", "number of KVM QEMU slots", "0")
    .option("--ci-runner-image <digest-reference>", "reviewed Sysbox supervisor image")
    .option("--ci-job-image <digest-reference>", "reviewed Sysbox job environment image")
    .option("--ci-sysbox-profile <file>", "advanced Sysbox execution profile, instead of image flags")
    .option("--ci-qemu-profile <file>", "reviewed QEMU execution profile")
    .action(async (directory: string, flags: { nativeGitImage: string; ordinaryCiImage: string; hostId: string;
      nativeGitPort: string; ordinaryCiPort: string; ciWorker?: string; ciSysboxSlots: string; ciQemuSlots: string;
      ciRunnerImage?: string; ciJobImage?: string; ciSysboxProfile?: string; ciQemuProfile?: string }) => {
      const prepared = await prepareControlPlane({ directory, ...flags,
        nativeGitPort: Number(flags.nativeGitPort), ordinaryCiPort: Number(flags.ordinaryCiPort),
        ciSysboxSlots: Number(flags.ciSysboxSlots), ciQemuSlots: Number(flags.ciQemuSlots),
        ciSysboxProfile: flags.ciSysboxProfile === undefined ? undefined : JSON.parse(await readFile(flags.ciSysboxProfile, "utf8")),
        ciQemuProfile: flags.ciQemuProfile === undefined ? undefined : JSON.parse(await readFile(flags.ciQemuProfile, "utf8")) });
      console.log(`Prepared ${prepared.configFile}`);
      console.log("No services were installed. Review the generated files, then run:");
      console.log(`dim installer install control-plane --config ${quote(prepared.configFile)}`);
      console.log(`dim managed control-plane connect ${quote(directory)}`);
      if (flags.ciWorker !== undefined) console.log("Connecting will write private worker.json; capacity starts only when you run the printed worker command.");
    });
  command.command("connect")
    .description("Verify the live generation and write private host/bootstrap connections")
    .argument("<directory>")
    .option("--endpoint <loopback-origin>", "SSH-forwarded native Git endpoint")
    .option("--ci-endpoint <origin>", "CI query endpoint, for a separate SSH loopback forward")
    .option("--output-directory <directory>", "new connection directory, useful after a service upgrade")
    .option("--ci-worker-state-directory <absolute-path>", "worker-owned state path on the host that will run the prepared worker")
    .action(async (directory: string, flags: { endpoint?: string; ciEndpoint?: string; outputDirectory?: string; ciWorkerStateDirectory?: string }) => {
      const connected = await connectControlPlane(directory, flags);
      await saveControlPlaneSelection({ hostConnectionFile: path.join(connected.directory, "host.json"),
        importerConnectionFile: path.join(connected.directory, "importer.json") });
      console.log(`Connected host ${connected.hostId} to generation ${connected.generationId}`);
      console.log(`Private connections: ${connected.directory}`);
      console.log("Selected this control plane for native Project and workspace commands on this host.");
      if (connected.workerConfigFile !== undefined) {
        console.log("CI capacity is configured but no worker was started. Run on the selected worker host:");
        console.log(`dim managed ci worker ${quote(connected.workerConfigFile)}`);
      } else if (connected.ciWorkerCount > 1) {
        console.log("Several CI workers are configured; generate each host's private worker configuration explicitly. No worker.json was selected.");
      }
      console.log("Bootstrap a reviewed repository with 'dim managed project bootstrap-native-root', using registrar.json and importer.json from that directory.");
    });
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
