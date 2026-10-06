import type {
  ControlPlaneDockerCommand,
  ControlPlaneDockerCommandResult
} from "../../../../core/packages/installer/src/controlPlaneDocker.js";
import { FirstInstallRunner } from "./controlPlaneInstallFixture.js";

type ProbeFailure =
  | { readonly kind: "probe"; readonly command: "check-config" | "check-bundle-config"; readonly output: string }
  | { readonly kind: "pull"; readonly image: "native-git" | "ordinary-ci"; readonly output: string };

export class ProbeFailureRunner extends FirstInstallRunner {
  constructor(private readonly failure: ProbeFailure) {
    super();
  }

  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    const result = await super.run(command);
    const args = command.args;
    const fails = this.failure.kind === "probe"
      ? args[0] === "run" && args.includes(this.failure.command)
      : args[0] === "pull" && (args[1] ?? "").includes(this.failure.image);
    return fails
      ? { exitCode: 1, stdout: this.failure.output, stderr: this.failure.output }
      : result;
  }
}
