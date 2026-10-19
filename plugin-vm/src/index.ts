import { readFile, mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { UserError, type WorkspaceHostPlugin, type WorkspaceHostPluginContext } from "@slop-lab/dim-core/workspace";
import { LinuxVmBudget } from "./budget.js";
import { CommandVmBudget } from "./budget-helper.js";
import { parseVmHostConfig, readVmHostConfig } from "./config.js";
import { IncusMachines } from "./incus.js";
import { IncusWorkspaceRuntime } from "./runtime.js";
import { PersistentVmService } from "./store.js";
import { importReviewedImage, type ReviewedImageDownload } from "./images.js";
import { serveVmConsole } from "./console.js";

export { CommandVmBudget } from "./budget-helper.js";
export { LinuxVmBudget, budgetValues, type VmBudget } from "./budget.js";
export { parseVmHostConfig, type VmHostConfig } from "./config.js";
export { IncusMachines, type VmIdentity, type VmInspection } from "./incus.js";
export { IncusWorkspaceRuntime } from "./runtime.js";
export { PersistentVmService, parsePersistentVm, type PersistentVm } from "./store.js";
export { serveVmConsole } from "./console.js";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "vm",
  runtime: {
    name: "vm",
    create(context) {
      const config = readVmHostConfig(context.stateRoot);
      return new IncusWorkspaceRuntime(new IncusMachines(config, context.runner, configuredBudget(config, context.runner), context.cleanupRunner));
    }
  },
  commands: [{ name: "vm", description: "Manage persistent auxiliary VMs and scoped browser consoles" }],
  async run(args, context) { await runVmCommand(args.slice(1), context); }
};

async function runVmCommand(args: string[], context: WorkspaceHostPluginContext): Promise<void> {
  const [command, name, argument] = args;
  if (command === "configure") {
    if (!name || args.length !== 2) throw new UserError("usage: dim vm configure REVIEWED-HOST-CONFIG.json");
    const config = parseVmHostConfig(JSON.parse(await readFile(name, "utf8")));
    const directory = path.join(context.stateRoot, "plugins", "vm");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write("VM host configuration saved. Create a workspace with: dim create SOURCE NAME --runtime vm --image INCUS_FINGERPRINT\n"); return;
  }
  const config = readVmHostConfig(context.stateRoot);
  if (command === "image") {
    if (name !== "import" || !argument || args.length < 5 || (args.length - 3) % 2 !== 0) throw new UserError("usage: dim vm image import URL --sha256 DIGEST [--rootfs-url URL --rootfs-sha256 DIGEST]");
    const options = new Map<string, string>();
    for (let index = 3; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!flag || !value || !["--sha256", "--rootfs-url", "--rootfs-sha256"].includes(flag) || options.has(flag)) throw new UserError("unknown, duplicate or missing image import option");
      options.set(flag, value);
    }
    const sha256 = options.get("--sha256"), rootfsUrl = options.get("--rootfs-url"), rootfsSha = options.get("--rootfs-sha256");
    if (!sha256 || (rootfsUrl === undefined) !== (rootfsSha === undefined)) throw new UserError("image import requires SHA-256 for every downloaded file");
    const input: ReviewedImageDownload = { url: argument, sha256, ...(rootfsUrl !== undefined && rootfsSha !== undefined ? { rootfs: { url: rootfsUrl, sha256: rootfsSha } } : {}) };
    process.stdout.write(`${JSON.stringify({ fingerprint: await importReviewedImage(config, input, context.runner, context.signal) })}\n`);
    return;
  }
  const machines = new IncusMachines(config, context.runner, configuredBudget(config, context.runner), context.cleanupRunner);
  const service = new PersistentVmService(context.stateRoot, machines, context.store);
  switch (command) {
    case "ls": {
      if (args.length !== 1) throw new UserError("usage: dim vm ls");
      const records = await service.list();
      const result = await Promise.all(records.map(async (record) => ({ name: record.name, id: record.id, image: record.image,
        running: (await machines.inspect(record))?.running ?? false, workspaceIds: record.grants.map((grant) => grant.workspaceId) })));
      process.stdout.write(`${JSON.stringify(result)}\n`); return;
    }
    case "create": {
      if (!name || !argument || args.length !== 3) throw new UserError("usage: dim vm create NAME INCUS_FINGERPRINT");
      const record = await service.create(name, argument, { cpuCount: "2", memory: "4g", pidsLimit: "2048" });
      process.stdout.write(`${JSON.stringify({ name: record.name, id: record.id, running: false })}\n`); return;
    }
    case "start": case "stop": case "discard": {
      if (!name || args.length !== 2) throw new UserError(`usage: dim vm ${command} NAME`);
      await service[command](name); process.stdout.write(`${JSON.stringify({ operation: command, name })}\n`); return;
    }
    case "allocation": {
      const scope = name, target = argument;
      if (!target || (scope !== "workspace" && scope !== "machine") || (args.length - 3) % 2 !== 0) throw new UserError("usage: dim vm allocation workspace|machine NAME [--cpus COUNT] [--memory SIZE]");
      const changes: { cpuCount?: number; memory?: string } = {};
      for (let index = 3; index < args.length; index += 2) {
        const flag = args[index], value = args[index + 1];
        if (value === undefined) throw new UserError("missing guest allocation value");
        if (flag === "--cpus" && changes.cpuCount === undefined) changes.cpuCount = Number(value);
        else if (flag === "--memory" && changes.memory === undefined) changes.memory = value;
        else throw new UserError("unknown or duplicate guest allocation option");
      }
      const allocation = scope === "machine" ? await service.allocation(target, changes) : await context.store.withLock(target, async () => {
        const workspace = await context.store.read(target);
        if (workspace.runtime !== "vm") throw new UserError("guest allocation applies only to VM workspaces");
        return machines.updateAllocation(workspace, changes);
      });
      process.stdout.write(`${JSON.stringify(allocation)}\n`); return;
    }
    case "resources": {
      if (!name || args.length < 4 || args.length % 2 !== 0) throw new UserError("usage: dim vm resources NAME [--cpus VALUE] [--memory VALUE] [--pids VALUE]");
      const changes: Partial<import("@slop-lab/dim-core/workspace").WorkspaceResources> = {};
      for (let index = 2; index < args.length; index += 2) {
        const flag = args[index], value = args[index + 1];
        const key = flag === "--cpus" ? "cpuCount" : flag === "--memory" ? "memory" : flag === "--pids" ? "pidsLimit" : undefined;
        if (!key || value === undefined || changes[key] !== undefined) throw new UserError("unknown, duplicate or missing VM resource option");
        changes[key] = value;
      }
      const record = await service.resources(name, changes);
      process.stdout.write(`${JSON.stringify({ name, resources: record.resources, recreated: false })}\n`); return;
    }
    case "grant": {
      if (!name || !argument || args.length !== 3) throw new UserError("usage: dim vm grant VM WORKSPACE");
      const token = await service.grant(name, argument);
      // Deliberately scoped credential, never an Incus or host operator token.
      const endpoint = config.console ?? { address: "127.0.0.1", port: 8089 };
      const payload = JSON.stringify({ vm: name, token, consoleUrl: `http://${endpoint.address}:${endpoint.port}` });
      const { Readable } = await import("node:stream");
      const code = `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const d=p.join(os.homedir(),'.config/dim/vms');fs.mkdirSync(d,{recursive:true,mode:0o700});const v=JSON.parse(s);fs.writeFileSync(p.join(d,v.vm+'.json'),s+'\\n',{mode:0o600});});`;
      if (await context.service.exec(argument, ["node", "-e", code], { stdin: Readable.from([payload]), signal: context.signal }) !== 0) {
        await service.revoke(name, (await context.store.read(argument)).id);
        throw new UserError("could not deliver scoped VM credential to the workspace");
      }
      process.stdout.write(`VM console access granted to '${argument}'. Its scoped credential is ~/.config/dim/vms/${name}.json inside the workspace.\n`); return;
    }
    case "revoke": {
      if (!name || !argument || args.length !== 3) throw new UserError("usage: dim vm revoke VM WORKSPACE_UUID");
      await service.revoke(name, argument); process.stdout.write("VM access revoked.\n"); return;
    }
    case "console": {
      if (args.length > 2 || (name !== undefined && !/^[1-9][0-9]*$/.test(name))) throw new UserError("usage: dim vm console [PORT]");
      const endpoint = config.console ?? { address: "127.0.0.1", port: 8089 };
      const port = name === undefined ? endpoint.port : Number(name);
      if (!config.spiceAssets) throw new UserError("configure reviewed spiceAssets before starting the browser console");
      const directory = path.join(context.stateRoot, "plugins", "vm");
      const tokenFile = path.join(directory, "console-token");
      let token: string;
      try { token = (await readFile(tokenFile, "utf8")).trim(); }
      catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        token = randomBytes(32).toString("base64url");
        await writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
      }
      const server = await serveVmConsole(service, config, { host: endpoint.address, port, token, assets: config.spiceAssets });
      context.signal.addEventListener("abort", () => server.close(), { once: true });
      process.stdout.write(`VM browser console: http://${endpoint.address}:${port}; private owner token: ${tokenFile}. Use an SSH local forward for a remote host.\n`);
      await once(server, "close"); return;
    }
    default: throw new UserError("usage: dim vm configure FILE | ls | create NAME FINGERPRINT | start NAME | stop NAME | discard NAME | grant VM WORKSPACE | revoke VM WORKSPACE_UUID | console PORT");
  }
}

function configuredBudget(config: import("./config.js").VmHostConfig, runner: import("@slop-lab/dim-core/workspace").CommandRunner): CommandVmBudget {
  if (!config.budgetHelper) throw new UserError("VM host requires the reviewed root budget helper and Incus QEMU admission setup; configure budgetHelper before creating VMs");
  return new CommandVmBudget(runner, config.budgetHelper);
}
