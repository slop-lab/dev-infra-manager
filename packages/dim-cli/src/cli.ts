#!/usr/bin/env node
import { once } from "node:events";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { AddHelpTextContext, Command, CommanderError } from "commander";
import {
  applyProjectRepositoryProtection,
  createProject,
  createProjectRepository,
  createWorkspace,
  configuredDimController,
  discardWorkspace,
  ensureGitea,
  execWorkspace,
  importProjectRepository,
  lifecycleOptions,
  type LifecycleOptions,
  listProjectRepositories,
  listProjects,
  listWorkspaces,
  loadInstalledPlugins,
  ProcessRunner,
  projectRepositoryHostUrl,
  projectRepositoryWorkspaceUrl,
  purgeProject,
  removeProject,
  initializeControllerRoutes,
  resolvePluginHome,
  restartWorkspace,
  runDoctor,
  runWorkspace,
  setupWorkspace,
  showProject,
  showProjectRepository,
  showWorkspace,
  startWorkspace,
  stopWorkspace,
  updateWorkspace,
  UserError,
} from "@slop-lab/dev-infra-manager-core";
import {
  readExternalUrlConfig,
  writeExternalUrlConfig,
  type CaddyIngressConfig,
  type ExternalUrlIngressConfig
} from "@slop-lab/dim-external-url-contracts";
import {
  renderCaddyDeployment,
  verifyCaddyIngress
} from "@slop-lab/dim-ingress-external-url-caddy";
import {
  ensureCloudflareWildcard,
  removeCloudflareWildcard,
  verifyCloudflareWildcard
} from "@slop-lab/dim-provider-dns-cloudflare";

const runner = new ProcessRunner();
const program = new Command();

program
  .name("dim")
  .description("Isolated, persistent development workspaces")
  .version("0.2.0")
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .addHelpText("afterAll", installerFacadeHelpText);

const project = program.command("project").description("Manage project metadata and Git namespaces");

project.command("create")
  .description("Create a project and its managed Git namespace")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await createProject(runner, lifecycleOptions(), name), flags));

project.command("list")
  .alias("ls")
  .description("List projects")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) =>
    printList(await listProjects(lifecycleOptions()), ["name", "phase", "gitNamespace", "rootRepositoryAlias", "rootRef"], flags)
  );

project.command("show")
  .description("Show a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await showProject(lifecycleOptions(), name), flags));

project.command("remove")
  .description("Remove project metadata while preserving Git repositories")
  .argument("<project>")
  .action(async (name: string) => {
    await removeProject(lifecycleOptions(), name);
  });

project.command("purge")
  .description("Delete an unused project and its DIM-managed Git organization")
  .argument("<project>")
  .requiredOption("--yes", "confirm permanent repository deletion")
  .action(async (name: string) => purgeProject(runner, lifecycleOptions(), name));

const repo = program.command("repo").description("Manage project-scoped repositories");

repo.command("create")
  .description("Create an empty managed repository")
  .argument("<project>")
  .argument("<alias>")
  .option("--root", "make this the project root repository")
  .option("--ref <branch-or-ref>", "root branch/ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, alias: string, flags: RepoFlags) => {
    print(await createProjectRepository(runner, lifecycleOptions(), {
      project: projectName,
      alias,
      protectedPatterns: flags.protect === undefined ? [] : commaSeparated(flags.protect),
      root: flags.root ?? false,
      ...(flags.root ? { rootRef: flags.ref } : {})
    }), flags);
  });

repo.command("import")
  .description("Create a managed repository and mirror an existing Git URL")
  .argument("<project>")
  .argument("<alias>")
  .argument("<source>")
  .option("--root", "make this the project root repository")
  .option("--ref <branch-or-ref>", "root branch/ref; defaults to the repository HEAD")
  .option("--protect <patterns>", "comma-separated protected branch patterns")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, alias: string, source: string, flags: RepoFlags) => {
    print(await importProjectRepository(runner, lifecycleOptions(), {
      project: projectName,
      alias,
      source,
      protectedPatterns: flags.protect === undefined ? [] : commaSeparated(flags.protect),
      root: flags.root ?? false,
      ...(flags.root ? { rootRef: flags.ref } : {})
    }), flags);
  });

repo.command("list")
  .alias("ls")
  .description("List repositories in a project")
  .argument("<project>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) =>
    printList(await listProjectRepositories(lifecycleOptions(), name), ["alias", "phase", "hostUrl", "workspaceUrl"], flags)
  );

repo.command("show")
  .description("Show a project repository")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await showProjectRepository(lifecycleOptions(), name, alias), flags)
  );

repo.command("protect")
  .description("Apply configured branch protection after the initial push")
  .argument("<project>")
  .argument("<alias>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, alias: string, flags: JsonFlags) =>
    print(await applyProjectRepositoryProtection(runner, lifecycleOptions(), name, alias), flags)
  );

repo.command("url")
  .description("Print a repository URL")
  .argument("<project>")
  .argument("<alias>")
  .option("--workspace", "print the URL reachable from workspaces")
  .action(async (name: string, alias: string, flags: { workspace?: boolean }) =>
    console.log(await (flags.workspace
      ? projectRepositoryWorkspaceUrl(lifecycleOptions(), name, alias)
      : projectRepositoryHostUrl(lifecycleOptions(), name, alias))));

program.command("create")
  .description("Create a persistent workspace for a project")
  .argument("<project>")
  .argument("<workspace>")
  .option("--profile <profile>", "Compose capability profile", collect, [])
  .option("--git-user-name <name>")
  .option("--git-user-email <email>")
  .option("--cpus <count>", "workspace CPU limit")
  .option("--memory <size>", "workspace memory limit")
  .option("--pids-limit <count>", "workspace PID limit")
  .option("--kvm", "pass the host /dev/kvm device into the trusted workspace container")
  .option("--json", "print machine-readable JSON")
  .action(async (projectName: string, name: string, flags: WorkspaceCreateFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await createWorkspace(runner, options, {
      project: projectName,
      name,
      profiles: flags.profile,
      runtimeBackend: options.defaultWorkspaceBackend,
      ...(flags.kvm ? { kvm: true } : {}),
      cpuCount: flags.cpus ?? options.cpuCount,
      memory: flags.memory ?? options.memory,
      pidsLimit: flags.pidsLimit ?? options.pidsLimit,
      ...(flags.gitUserName ? { gitUserName: flags.gitUserName } : {}),
      ...(flags.gitUserEmail ? { gitUserEmail: flags.gitUserEmail } : {})
    }), flags);
  });

program.command("ls")
  .alias("list")
  .description("List workspaces")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) =>
    printList(
      await listWorkspaces(lifecycleOptions()),
      ["name", "projectName", "phase", "runtimeBackend", "rootRef"],
      flags
    )
  );

program.command("show")
  .description("Show a workspace")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => print(await showWorkspace(lifecycleOptions(), name), flags));

program.command("exec")
  .description("Execute a raw command in a running workspace")
  .argument("<workspace>")
  .argument("<command...>")
  .allowUnknownOption(true)
  .action(async (name: string, command: string[]) => {
    process.exitCode = await execWorkspace(runner, lifecycleOptions(), {
      name,
      command,
      interactive: interactive()
    });
  });

program.command("run")
  .description("Run a root project task through .dim/entrypoint.sh")
  .argument("<workspace>")
  .argument("<task...>")
  .allowUnknownOption(true)
  .action(async (name: string, task: string[]) => {
    process.exitCode = await runWorkspace(runner, lifecycleOptions(), {
      name,
      command: task,
      interactive: interactive()
    });
  });

program.command("setup")
  .description("Retry root project environment setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await setupWorkspace(runner, options, name), flags);
  });

program.command("update")
  .description("Fast-forward the root ref and run setup")
  .argument("<workspace>")
  .option("--profile <profile>", "replace Compose capability profiles", collect, [])
  .option("--clear-profiles", "remove all capability profiles")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: { profile: string[]; clearProfiles?: boolean; json?: boolean }) => {
    if (flags.clearProfiles && flags.profile.length > 0) {
      throw new UserError("--clear-profiles cannot be combined with --profile");
    }
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await updateWorkspace(
      runner,
      options,
      name,
      flags.clearProfiles ? [] : flags.profile.length > 0 ? flags.profile : undefined
    ), flags);
  });

program.command("start")
  .description("Start a stopped workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await startWorkspace(runner, options, name), flags);
  });

program.command("restart")
  .description("Restart a workspace, fast-forward its root ref, and run setup")
  .argument("<workspace>")
  .option("--json", "print machine-readable JSON")
  .action(async (name: string, flags: JsonFlags) => {
    const options = lifecycleOptions();
    await ensureManagedController(options);
    print(await restartWorkspace(runner, options, name), flags);
  });

program.command("stop")
  .description("Stop a workspace while preserving its checkout and inner-engine data")
  .argument("<workspace>")
  .action(async (name: string) => stopWorkspace(runner, lifecycleOptions(), name));

program.command("discard")
  .description("Permanently delete a workspace and unpushed changes")
  .argument("<workspace>")
  .requiredOption("--yes", "confirm permanent deletion")
  .action(async (name: string) => {
    const options = lifecycleOptions();
    await discardWorkspace(runner, options, name);
    if ((await listWorkspaces(options)).length === 0) await stopManagedController(options);
  });

program.command("doctor")
  .description("Check host and workspace runtime readiness")
  .action(async () => {
    const options = lifecycleOptions();
    const checks = await runDoctor(runner, options.defaultWorkspaceBackend, options);
    for (const check of checks) console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

const plugin = program.command("plugin").description("Inspect installed DIM plugins");
plugin.command("list").option("--json", "print machine-readable JSON").action(async (flags: JsonFlags) => {
  const home = await resolvePluginHome();
  const loaded = await loadInstalledPlugins(home);
  try {
    print({
      pluginHome: home,
      plugins: loaded.manifest.plugins,
      controllerRoutes: loaded.registered.controllerRoutes.map((route) => `${route.method} /api${route.path}`)
    }, flags);
  } finally {
    await loaded.registered.dispose();
  }
});

const externalUrl = program.command("external-url").description("Configure ingresses and manage workspace URLs");

externalUrl.command("add-provider")
  .description("Add or replace an external URL infrastructure provider")
  .argument("<driver>", "provider driver; currently cloudflare")
  .argument("<name>")
  .requiredOption("--zone <domain>", "Cloudflare zone")
  .requiredOption("--record-type <type>", "wildcard record type: A, AAAA, or CNAME")
  .requiredOption("--target <value>", "wildcard record target")
  .option("--credential-env <name>", "API token environment variable", "CF_API_TOKEN")
  .option("--proxied", "enable Cloudflare proxying", false)
  .action(async (driver: string, name: string, flags: CloudflareProviderFlags) => {
    if (driver !== "cloudflare") throw new UserError("provider driver must be cloudflare");
    if (flags.recordType !== "A" && flags.recordType !== "AAAA" && flags.recordType !== "CNAME") {
      throw new UserError("--record-type must be A, AAAA, or CNAME");
    }
    const config = await readExternalUrlConfig();
    config.providers[name] = {
      driver: "cloudflare",
      zone: flags.zone,
      recordType: flags.recordType,
      target: flags.target,
      proxied: flags.proxied ?? false,
      credentialEnv: flags.credentialEnv
    };
    await writeExternalUrlConfig(config);
    console.log(`Configured external URL provider '${name}'`);
  });

externalUrl.command("add-ingress")
  .description("Add or replace a named external URL ingress")
  .argument("<name>")
  .requiredOption("--driver <driver>", "builtin-http or caddy")
  .requiredOption("--description <text>")
  .requiredOption("--scheme <scheme>", "http or https")
  .requiredOption("--domain <domain>")
  .requiredOption("--listen-host <host>")
  .requiredOption("--listen-port <port>")
  .option("--port <port>", "port included in generated URLs")
  .option("--upstream-mode <mode>", "container-ip or container-dns", "container-ip")
  .option("--provider <name>", "DNS provider required by caddy")
  .option("--acme-email <email>")
  .action(async (name: string, flags: IngressFlags) => {
    if (flags.driver !== "builtin-http" && flags.driver !== "caddy") {
      throw new UserError("--driver must be builtin-http or caddy");
    }
    if (flags.scheme !== "http" && flags.scheme !== "https") throw new UserError("--scheme must be http or https");
    if (flags.upstreamMode !== "container-ip" && flags.upstreamMode !== "container-dns") {
      throw new UserError("--upstream-mode must be container-ip or container-dns");
    }
    const base = {
      description: flags.description,
      scheme: flags.scheme,
      domain: flags.domain,
      ...(flags.port === undefined ? {} : { port: cliPort(flags.port, "--port", false) }),
      listenHost: flags.listenHost,
      listenPort: cliPort(flags.listenPort, "--listen-port", true),
      upstreamMode: flags.upstreamMode
    };
    let ingress: ExternalUrlIngressConfig;
    if (flags.driver === "caddy") {
      if (flags.scheme !== "https") throw new UserError("Caddy ingress requires --scheme https");
      if (!flags.provider) throw new UserError("Caddy ingress requires --provider");
      ingress = {
        ...base,
        driver: "caddy",
        scheme: "https",
        provider: flags.provider,
        ...(flags.acmeEmail === undefined ? {} : { acmeEmail: flags.acmeEmail })
      };
    } else {
      ingress = { ...base, driver: "builtin-http" };
    }
    const config = await readExternalUrlConfig();
    config.ingresses[name] = ingress;
    await writeExternalUrlConfig(config);
    console.log(`Configured external URL ingress '${name}'`);
  });

externalUrl.command("list-providers")
  .description("List configured external URL infrastructure providers")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const config = await readExternalUrlConfig();
    const values = Object.entries(config.providers).map(([name, provider]) => ({ name, ...provider }));
    printList(values, ["name", "driver", "zone", "recordType", "target", "proxied"], flags);
  });

externalUrl.command("remove-provider")
  .description("Remove an unused external URL infrastructure provider")
  .argument("<name>")
  .action(async (name: string) => {
    const config = await readExternalUrlConfig();
    if (!config.providers[name]) throw new UserError(`external URL provider '${name}' is not configured`);
    const dependent = Object.entries(config.ingresses)
      .find(([, ingress]) => ingress.driver === "caddy" && ingress.provider === name);
    if (dependent) throw new UserError(`external URL provider '${name}' is used by ingress '${dependent[0]}'`);
    delete config.providers[name];
    await writeExternalUrlConfig(config);
  });

externalUrl.command("list-ingresses")
  .description("List configured external URL ingresses")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => {
    const config = await readExternalUrlConfig();
    const values = Object.entries(config.ingresses).map(([name, ingress]) => ({ name, ...ingress }));
    printList(values, ["name", "driver", "scheme", "domain", "listenHost", "listenPort"], flags);
  });

externalUrl.command("remove-ingress")
  .description("Remove an ingress from host configuration")
  .argument("<name>")
  .option("--cleanup-dns", "remove the ingress wildcard DNS record first")
  .action(async (name: string, flags: { cleanupDns?: boolean }) => {
    const config = await readExternalUrlConfig();
    const ingress = config.ingresses[name];
    if (!ingress) throw new UserError(`external URL ingress '${name}' is not configured`);
    if (flags.cleanupDns) {
      if (ingress.driver !== "caddy") {
        throw new UserError(`ingress '${name}' does not have provider-managed DNS`);
      }
      const provider = config.providers[ingress.provider];
      if (!provider) throw new UserError(`provider '${ingress.provider}' is not configured`);
      const record = await verifyCloudflareWildcard(provider, ingress.domain);
      await removeCloudflareWildcard(provider, record);
    }
    delete config.ingresses[name];
    await writeExternalUrlConfig(config);
  });

externalUrl.command("setup-ingress")
  .description("Reconcile DNS and render deployment files for an ingress")
  .argument("<name>")
  .option("--output <directory>", "deployment output directory", ".dim/external-url")
  .action(async (name: string, flags: { output: string }) => {
    const config = await readExternalUrlConfig();
    const ingress = config.ingresses[name];
    if (!ingress) throw new UserError(`external URL ingress '${name}' is not configured`);
    if (ingress.driver !== "caddy") throw new UserError(`ingress '${name}' does not require Caddy setup`);
    const provider = config.providers[ingress.provider];
    if (!provider) throw new UserError(`provider '${ingress.provider}' is not configured`);
    await ensureCloudflareWildcard(provider, ingress.domain);
    const deployment = renderCaddyDeployment(name, ingress, provider);
    const output = path.resolve(flags.output, name);
    await mkdir(output, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(path.join(output, "Dockerfile"), deployment.dockerfile),
      writeFile(path.join(output, "Caddyfile"), deployment.caddyfile),
      writeFile(path.join(output, "compose.yml"), deployment.compose),
      writeFile(path.join(output, ".env.example"), deployment.environmentExample, { mode: 0o600 })
    ]);
    console.log(`Reconciled wildcard DNS and wrote Caddy deployment to ${output}`);
  });

externalUrl.command("verify-ingress")
  .description("Verify provider state and HTTPS ingress reachability")
  .argument("<name>")
  .action(async (name: string) => {
    const config = await readExternalUrlConfig();
    const ingress = config.ingresses[name];
    if (!ingress) throw new UserError(`external URL ingress '${name}' is not configured`);
    if (ingress.driver === "caddy") {
      const provider = config.providers[ingress.provider];
      if (!provider) throw new UserError(`provider '${ingress.provider}' is not configured`);
      await verifyCloudflareWildcard(provider, ingress.domain);
      await verifyCaddyIngress(ingress);
    }
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

externalUrl.command("create")
  .description("Create an external URL for a target in the current workspace")
  .requiredOption("--ingress <name>")
  .requiredOption("--service <name>")
  .option("--container <name>", "nested container path; repeat up to twice", collect, [])
  .requiredOption("--port <port>")
  .option("--protocol <protocol>", "target protocol", "http")
  .option("--path <path>", "external URL path")
  .option("--workspace <name>", "use a host-side workspace grant")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: ExternalUrlCreateFlags) => {
    if (flags.protocol !== "http" && flags.protocol !== "https") {
      throw new UserError("--protocol must be http or https");
    }
    const result = await externalUrlControllerRequest("/api/urls", {
      method: "POST",
      body: JSON.stringify({
        ingress: flags.ingress,
        service: flags.service,
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

externalUrl.command("remove")
  .description("Revoke an external URL in the current workspace")
  .argument("<id>")
  .option("--workspace <name>", "use a host-side workspace grant")
  .action(async (id: string, flags: WorkspaceControllerFlags) => {
    await externalUrlControllerRequest(`/api/urls/${encodeURIComponent(id)}`, { method: "DELETE" }, flags.workspace);
  });

const controller = program.command("controller").description("Run trusted DIM controller services");
controller.command("serve")
  .description("Serve trusted workspace controller APIs")
  .option("--socket <path>", "listen on a Unix socket")
  .option("--host <host>", "listen address for explicit TCP mode")
  .option("--port <port>", "listen port for explicit TCP mode")
  .action(async (flags: { socket?: string; host?: string; port?: string }) => {
    if (flags.socket && (flags.host || flags.port)) {
      throw new UserError("--socket cannot be combined with --host or --port");
    }
    if (!flags.socket && (!flags.host || !flags.port)) {
      throw new UserError("controller serve requires --socket, or both --host and --port");
    }
    const loaded = await loadInstalledPlugins(await resolvePluginHome());
    await initializeControllerRoutes(lifecycleOptions(), loaded.registered);
    const server = configuredDimController(lifecycleOptions(), loaded.registered);
    if (flags.socket) {
      await mkdir(path.dirname(flags.socket), { recursive: true });
      await rm(flags.socket, { force: true });
      server.listen(flags.socket);
    } else {
      const port = Number(flags.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new UserError("--port must be between 1 and 65535");
      }
      server.listen(port, flags.host);
    }
    await once(server, "listening");
    if (flags.socket) {
      await chmod(flags.socket, 0o666);
      await writeFile(path.join(path.dirname(flags.socket), "controller.pid"), `${process.pid}\n`);
      console.log(`DIM controller listening on ${flags.socket}`);
    } else {
      console.log(`DIM controller listening on http://${flags.host}:${flags.port}`);
    }
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (flags.socket) {
      await rm(flags.socket, { force: true });
      await rm(path.join(path.dirname(flags.socket), "controller.pid"), { force: true });
    }
    await loaded.registered.dispose();
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
  await ensureGitea(runner, lifecycleOptions());
  console.log("Managed Gitea is ready");
});
service.command("credentials")
  .description("Print managed Gitea credentials")
  .requiredOption("--show-secrets")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => print(await ensureGitea(runner, lifecycleOptions()), flags));

const x = program.command("x").description("Run a command with DIM-provided integration settings");
x.command("git")
  .description("Run Git with managed Gitea credentials")
  .argument("<args...>")
  .allowUnknownOption(true)
  .action(async (args: string[]) => {
    const credentials = await ensureGitea(runner, lifecycleOptions());
    const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
    process.exitCode = await runner.runStreaming("git", ["-c", `credential.helper=${helper}`, ...args], {
      env: {
        ...process.env,
        DIM_GIT_USERNAME: credentials.writerUsername,
        DIM_GIT_TOKEN: credentials.writerPassword,
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  });

const gitIntegration = program.command("git").description("Configure Git access to DIM-managed repositories");
gitIntegration.command("setup")
  .description("Install DIM's URL-scoped Git credential helper in global Git config")
  .action(async () => {
    await ensureGitea(runner, lifecycleOptions());
    const baseUrl = `http://127.0.0.1:${lifecycleOptions().giteaPort}`;
    const helperKey = `credential.${baseUrl}.helper`;
    const pathKey = `credential.${baseUrl}.useHttpPath`;
    const helper = await runner.run("git", ["config", "--global", "--replace-all", helperKey, "!dim git credential-helper"]);
    if (helper.exitCode !== 0) throw new UserError(`failed to configure Git credential helper: ${helper.stderr.trim()}`);
    const usePath = await runner.run("git", ["config", "--global", "--replace-all", pathKey, "true"]);
    if (usePath.exitCode !== 0) throw new UserError(`failed to configure Git credential path matching: ${usePath.stderr.trim()}`);
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
    const options = lifecycleOptions();
    if (fields.protocol !== "http" || fields.host !== `127.0.0.1:${options.giteaPort}`) return;
    const credentials = await ensureGitea(runner, options);
    console.log(`username=${credentials.writerUsername}`);
    console.log(`password=${credentials.writerPassword}`);
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

program.exitOverride();

interface RepoFlags {
  root?: boolean;
  ref?: string;
  protect?: string;
  json?: boolean;
}

interface JsonFlags {
  json?: boolean;
}

interface WorkspaceCreateFlags extends JsonFlags {
  profile: string[];
  gitUserName?: string;
  gitUserEmail?: string;
  cpus?: string;
  memory?: string;
  pidsLimit?: string;
  kvm?: boolean;
}

interface CloudflareProviderFlags {
  zone: string;
  recordType: "A" | "AAAA" | "CNAME";
  target: string;
  credentialEnv: string;
  proxied?: boolean;
}

interface IngressFlags {
  driver: "builtin-http" | "caddy";
  description: string;
  scheme: "http" | "https";
  domain: string;
  port?: string;
  listenHost: string;
  listenPort: string;
  upstreamMode: "container-ip" | "container-dns";
  provider?: string;
  acmeEmail?: string;
}

interface ExternalUrlCreateFlags extends JsonFlags {
  ingress: string;
  service: string;
  container: string[];
  port: string;
  protocol: "http" | "https";
  path?: string;
  workspace?: string;
}

interface WorkspaceControllerFlags extends JsonFlags {
  workspace?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function commaSeparated(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new UserError("--protect must contain at least one pattern");
  return values;
}

function installerFacadeHelpText(context: AddHelpTextContext): string {
  const rootText = `
Typical flow:
  dim project create PROJECT
  dim repo create PROJECT ROOT --root
  git push "$(dim repo url PROJECT ROOT)" main
  dim repo protect PROJECT ROOT
  dim create PROJECT WORKSPACE
  dim exec WORKSPACE -- bash

Run 'dim help --all' to list administrative commands.`;

  if (process.env.DIM_INVOKED_VIA_INSTALLER !== "1") {
    return context.command === program ? rootText : "";
  }

  const installerVersion = process.env.DIM_INSTALLER_VERSION;
  const installerSuffix = installerVersion ? ` ${installerVersion}` : "";

  if (context.command !== program) {
    return `\nRunning via the DIM installer facade${installerSuffix}.`;
  }

  return `${rootText}

Running via the DIM installer facade${installerSuffix}. The following installer commands are also
available:
  dim installer        interactive installer UI
  dim install-cli      install or upgrade the DIM CLI
  dim install-plugin   install a DIM plugin`;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function readStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
}

function print(value: unknown, flags: JsonFlags = {}): void {
  if (flags.json || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    console.log(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
  }
}

function printList<T extends object>(records: T[], fields: string[], flags: JsonFlags = {}): void {
  if (flags.json) {
    print(records, flags);
    return;
  }
  if (records.length === 0) return;
  console.table(records.map((record) => {
    const values = record as Record<string, unknown>;
    return Object.fromEntries(fields.map((field) => [field, values[field] ?? ""]));
  }));
}

function cliPort(value: string, flag: string, zero: boolean): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < (zero ? 0 : 1) || port > 65_535) {
    throw new UserError(`${flag} must be between ${zero ? 0 : 1} and 65535`);
  }
  return port;
}

async function externalUrlControllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  return controllerRequest(pathname, init, workspace);
}

async function controllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  let socketPath = process.env.DIM_CONTROLLER_SOCKET;
  let api = process.env.DIM_CONTROLLER_API;
  let token = process.env.DIM_CONTROLLER_TOKEN;
  if (workspace) {
    const options = lifecycleOptions();
    socketPath ??= options.controllerSocketPath;
    try {
      token = (await readFile(path.join(options.stateRoot, "workspace-grants", workspace), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UserError(`workspace '${workspace}' has no controller grant`);
      }
      throw error;
    }
  }
  if ((!socketPath && !api) || !token) {
    throw new UserError(
      "DIM_CONTROLLER_SOCKET and DIM_CONTROLLER_TOKEN are required inside a workspace; use --workspace on the host"
    );
  }
  if (socketPath) {
    const response = await unixHttpRequest(socketPath, pathname, init, token);
    if (response.status < 200 || response.status >= 300) {
      throw new UserError(
        `controller request failed (${response.status})${response.body ? `: ${response.body.trim()}` : ""}`
      );
    }
    if (response.status === 204) return {};
    return JSON.parse(response.body) as unknown;
  }
  const response = await fetch(new URL(pathname, api), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new UserError(`external URL controller request failed (${response.status})${detail ? `: ${detail.trim()}` : ""}`);
  }
  if (response.status === 204) return {};
  return await response.json() as unknown;
}

async function unixHttpRequest(
  socketPath: string,
  pathname: string,
  init: RequestInit,
  token?: string
): Promise<{ status: number; body: string }> {
  const body = typeof init.body === "string" ? init.body : undefined;
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath,
      path: pathname,
      method: init.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function ensureManagedController(options: LifecycleOptions): Promise<void> {
  if (await controllerHealthy(options.controllerSocketPath)) return;
  const runtimeDir = path.dirname(options.controllerSocketPath);
  const lockDir = path.join(runtimeDir, "ensure.lock");
  await mkdir(runtimeDir, { recursive: true });
  let ownsLock = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      ownsLock = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await controllerHealthy(options.controllerSocketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!ownsLock) {
    await rm(lockDir, { recursive: true, force: true });
    return ensureManagedController(options);
  }
  try {
    if (await controllerHealthy(options.controllerSocketPath)) return;
    await rm(options.controllerSocketPath, { force: true });
    const log = await open(path.join(runtimeDir, "controller.log"), "a");
    const script = process.argv[1];
    if (!script) throw new UserError("cannot locate the DIM CLI entrypoint");
    const child = spawn(process.execPath, [
      ...process.execArgv,
      script,
      "controller",
      "serve",
      "--socket",
      options.controllerSocketPath
    ], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: process.env
    });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await controllerHealthy(options.controllerSocketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new UserError(`managed controller failed to start; see ${path.join(runtimeDir, "controller.log")}`);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function controllerHealthy(socketPath: string): Promise<boolean> {
  try {
    const response = await unixHttpRequest(socketPath, "/healthz", {}, undefined);
    return response.status === 200;
  } catch {
    return false;
  }
}

async function stopManagedController(options: LifecycleOptions): Promise<void> {
  try {
    const value = await readFile(path.join(path.dirname(options.controllerSocketPath), "controller.pid"), "utf8");
    const pid = Number(value.trim());
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

main();

async function main(): Promise<void> {
  try {
    const argv = process.argv[2] === "--"
      ? [process.argv[0] ?? "node", process.argv[1] ?? "dim", ...process.argv.slice(3)]
      : process.argv;
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = error.exitCode || 2;
      return;
    }
    if (error instanceof UserError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  }
}
