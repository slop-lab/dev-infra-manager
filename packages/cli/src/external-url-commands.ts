import { type Command } from "commander";
import { lifecycleOptions, UserError } from "@slop-lab/dim-core";
import {
  cliPort, collect, externalUrlAdmin, externalUrlControllerRequest, print, printList,
  restartManagedController, type DnsProviderAddFlags, type ExternalUrlCreateFlags,
  type IngressAddFlags, type JsonFlags, type WorkspaceControllerFlags
} from "./cli-support.js";

export function registerExternalUrlCommands(program: Command): void {
  const externalUrl = program.command("external-url").description("Configure ingresses and manage workspace URLs");

const externalUrlDnsProvider = externalUrl.command("dns-provider").description("Manage external URL DNS providers");

externalUrlDnsProvider.command("add")
  .description("Add or replace an external URL DNS provider")
  .argument("<driver>")
  .argument("[driver-argument...]", "arguments interpreted by the selected plugin driver")
  .requiredOption("--name <name>")
  .allowUnknownOption()
  .action(async (driver: string, driverArguments: string[], flags: DnsProviderAddFlags) => {
    await externalUrlAdmin("dns-provider-add", {
      driver,
      name: flags.name,
      arguments: driverArguments
    });
    console.log(`Configured external URL DNS provider '${flags.name}'`);
  });

const externalUrlIngress = externalUrl.command("ingress").description("Manage host-shared ingresses");

externalUrlIngress.command("add")
  .description("Add or replace a named external URL ingress")
  .argument("<driver>")
  .argument("[driver-argument...]", "arguments interpreted by the selected plugin driver")
  .requiredOption("--name <name>")
  .requiredOption("--description <text>")
  .requiredOption("--scheme <scheme>", "http or https")
  .allowUnknownOption()
  .action(async (driver: string, driverArguments: string[], flags: IngressAddFlags) => {
    if (flags.scheme !== "http" && flags.scheme !== "https") throw new UserError("--scheme must be http or https");
    await externalUrlAdmin("ingress-add", {
      driver,
      name: flags.name,
      description: flags.description,
      scheme: flags.scheme,
      arguments: driverArguments
    });
    await restartManagedController(lifecycleOptions());
    console.log(`Configured external URL ingress '${flags.name}'`);
  });

externalUrlDnsProvider.command("list")
  .description("List configured external URL DNS providers")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const values = await externalUrlAdmin<Record<string, unknown>[]>("dns-provider-list");
    printList(values, ["name", "driver"], flags);
  });

externalUrlDnsProvider.command("remove")
  .description("Remove an unused external URL DNS provider")
  .argument("<name>")
  .action(async (name: string) => {
    await externalUrlAdmin("dns-provider-remove", { name });
  });

externalUrlIngress.command("list")
  .description("List configured external URL ingresses")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const values = await externalUrlAdmin<Record<string, unknown>[]>("ingress-list");
    printList(values, ["name", "driver", "scheme", "description", "argument"], flags);
  });

externalUrlIngress.command("remove")
  .description("Remove an ingress from host configuration")
  .argument("<name>")
  .option("--cleanup-dns", "remove the ingress wildcard DNS record first")
  .action(async (name: string, flags: { cleanupDns?: boolean }) => {
    await (flags.cleanupDns
      ? externalUrlAdmin("ingress-remove", { name, cleanupDns: true })
      : externalUrlAdmin("ingress-remove", { name, cleanupDns: false }));
    await restartManagedController(lifecycleOptions());
  });

externalUrlIngress.command("verify")
  .description("Verify provider state and HTTPS ingress reachability")
  .argument("<name>")
  .action(async (name: string) => {
    await externalUrlAdmin("ingress-verify", { name });
    console.log(`External URL ingress '${name}' is ready`);
  });

externalUrl.command("discover")
  .description("Discover ingresses available to the current workspace")
  .option("--workspace <name>", "use a host-side workspace grant")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: WorkspaceControllerFlags) => {
    const discovery = await externalUrlControllerRequest("/api", {}, flags.workspace);
    const routes = (discovery as { routes?: Array<{ path?: string; discovery?: { ingresses?: unknown[] } }> }).routes ?? [];
    const ingresses = routes.find((route) => route.path === "/api/urls")?.discovery?.ingresses ?? [];
    printList(ingresses as Record<string, unknown>[], ["name", "scheme", "description"], flags);
  });

externalUrl.command("request")
  .description("Create an external URL for a target in the current workspace")
  .requiredOption("--ingress <name>")
  .option("--subdomain <name>", "relative subdomain; defaults to the next workspace-prefixed index")
  .option("--container <name>", "nested container path; repeat up to twice", collect, [])
  .requiredOption("--port <port>")
  .option("--protocol <protocol>", "target protocol", "http")
  .option("--path <path>", "external URL path")
  .option("--workspace <name>", "use a host-side workspace grant")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: ExternalUrlCreateFlags) => {
    if (flags.protocol !== "http" && flags.protocol !== "https" && flags.protocol !== "tcp") {
      throw new UserError("--protocol must be http, https, or tcp");
    }
    const result = await externalUrlControllerRequest("/api/urls", {
      method: "POST",
      body: JSON.stringify({
        ingress: flags.ingress,
        ...(flags.subdomain === undefined ? {} : { subdomain: flags.subdomain }),
        target: {
          containers: flags.container,
          port: cliPort(flags.port, "--port", false),
          protocol: flags.protocol
        },
        ...(flags.path === undefined ? {} : { path: flags.path })
      })
    }, flags.workspace);
    print(result, flags);
  });

externalUrl.command("list")
  .description("List external URLs for the current workspace")
  .option("--workspace <name>", "use a host-side workspace grant")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: WorkspaceControllerFlags) =>
    print(await externalUrlControllerRequest("/api/urls", {}, flags.workspace), flags)
  );

externalUrl.command("revoke")
  .description("Revoke an external URL in the current workspace")
  .argument("<id>")
  .option("--workspace <name>", "use a host-side workspace grant")
  .action(async (id: string, flags: WorkspaceControllerFlags) => {
    await externalUrlControllerRequest(`/api/urls/${encodeURIComponent(id)}`, { method: "DELETE" }, flags.workspace);
  });
}
