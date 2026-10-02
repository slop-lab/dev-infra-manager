import { UserError } from "@slop-lab/dim-core";
import type { Command } from "commander";

export function registerControlPlaneInstallCommand(program: Command): void {
  program.command("install-cp")
    .description("Install DIM services on a control-plane-only host")
    .action(() => {
      throw new UserError(
        "install-cp is unavailable: reviewed native Git service configuration and CI scheduler/webhook deployment contracts are required; no services were changed"
      );
    });
}
