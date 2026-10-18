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
    .action(async (directory: string, flags: { nativeGitImage: string; ordinaryCiImage: string; hostId: string; nativeGitPort: string; ordinaryCiPort: string }) => {
      const prepared = await prepareControlPlane({ directory, ...flags,
        nativeGitPort: Number(flags.nativeGitPort), ordinaryCiPort: Number(flags.ordinaryCiPort) });
      console.log(`Prepared ${prepared.configFile}`);
      console.log("No services were installed. Review the generated files, then run:");
      console.log(`dim installer install control-plane --config ${quote(prepared.configFile)}`);
      console.log(`dim managed control-plane connect ${quote(directory)}`);
    });
  command.command("connect")
    .description("Verify the live generation and write private host/bootstrap connections")
    .argument("<directory>")
    .option("--endpoint <loopback-origin>", "SSH-forwarded native Git endpoint")
    .option("--output-directory <directory>", "new connection directory, useful after a service upgrade")
    .action(async (directory: string, flags: { endpoint?: string; outputDirectory?: string }) => {
      const connected = await connectControlPlane(directory, flags);
      console.log(`Connected host ${connected.hostId} to generation ${connected.generationId}`);
      console.log(`Private connections: ${connected.directory}`);
      console.log(`export DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=${quote(`${connected.directory}/host.json`)}`);
      console.log(`export DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=${quote(`${connected.directory}/importer.json`)}`);
      console.log("Bootstrap a reviewed repository with 'dim managed project bootstrap-native-root', using registrar.json and importer.json from that directory.");
    });
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
