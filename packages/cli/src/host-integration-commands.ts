import { type Command } from "commander";
import { UserError } from "@slop-lab/dim-core";
import {
  adminCall, adminStreamCall, controllerRequest, print, readStdin, runner, type JsonFlags
} from "./cli-support.js";
import { matchesGitCredentialScope } from "./gitCredentialScope.js";

export function registerHostIntegrationCommands(program: Command): void {
  const host = program.command("host").description("Manage DIM host runtime lifecycle");
host.command("status")
  .description("Show DIM host runtime readiness and pending restore targets")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => print(await adminCall("host.status"), flags));
host.command("shutdown")
  .description("Gracefully stop DIM runtimes while preserving all managed volumes")
  .action(async () => {
    await adminStreamCall("host.shutdown");
    console.log("DIM host runtimes are stopped; the controller remains available");
  });
host.command("start")
  .description("Restore the DIM runtimes that were active before host shutdown")
  .action(async () => {
    await adminStreamCall("host.start");
    console.log("DIM host runtimes are ready");
  });

const hostInput = program.command("host-input").description("Read an allowed host setting from a workspace");
hostInput.command("get")
  .argument("<provider>")
  .argument("<key>")
  .option("--parameters <parameters>")
  .action(async (provider: string, key: string, flags: { parameters?: string }) => {
    const result = await controllerRequest(
      `/api/host-inputs/${encodeURIComponent(provider)}`,
      {
        method: "POST",
        body: JSON.stringify({ key, ...(flags.parameters === undefined ? {} : { parameters: flags.parameters }) })
      }
    ) as { value?: unknown };
    if (typeof result.value !== "string") throw new UserError("host input provider returned an invalid value");
    process.stdout.write(`${result.value}\n`);
  });

const admin = program.command("admin", { hidden: true }).description("Low-level service administration");
const service = admin.command("service");
service.command("ensure").description("Reconcile the managed Gitea service").action(async () => {
  await adminCall("service.ensure");
  console.log("Managed Gitea is ready");
});
service.command("credentials")
  .description("Print managed Gitea credentials")
  .requiredOption("--show-secrets")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => print(await adminCall("service.ensure"), flags));

const x = program.command("x").description("Run a command with DIM-provided integration settings");
x.command("git")
  .description("Run Git with the configured host-maintainer credential")
  .argument("<args...>")
  .allowUnknownOption(true)
  .action(async (args: string[]) => {
    const credentials = await adminCall<{ username: string; password: string }>("git.credentials");
    const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
    process.exitCode = await runner.runStreaming("git", ["-c", `credential.helper=${helper}`, ...args], {
      env: {
        ...process.env,
        DIM_GIT_USERNAME: credentials.username,
        DIM_GIT_TOKEN: credentials.password,
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  });

const gitIntegration = program.command("git").description("Configure Git access to DIM Project repositories");
gitIntegration.command("setup")
  .description("Install DIM's URL-scoped Git credential helper in global Git config")
  .action(async () => {
    const { baseUrl } = await adminCall<{ baseUrl: string }>("git.setup");
    console.log(`Configured DIM credentials for ${baseUrl}`);
  });

gitIntegration.command("credential-helper", { hidden: true })
  .description("Serve credentials using the Git credential-helper protocol")
  .argument("[operation]", "get, store, or erase", "get")
  .action(async (operation: string) => {
    const input = await readStdin();
    if (operation !== "get") return;
    const fields = Object.fromEntries(input
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
    const credentials = await adminCall<{ username: string; password: string; baseUrl: string }>("git.credentials");
    if (!matchesGitCredentialScope(fields, credentials.baseUrl)) return;
    console.log(`username=${credentials.username}`);
    console.log(`password=${credentials.password}`);
  });

program.command("help")
  .description("Show help")
  .option("--all", "include administrative commands")
  .action((flags: { all?: boolean }) => {
    if (flags.all) admin.showHelpAfterError();
    program.outputHelp();
    if (flags.all) {
      console.log("\nAdministrative commands:");
      admin.outputHelp();
    }
  });
}
