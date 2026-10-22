/** Complete, nondestructive repository development installation of the managed pair. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { realpath, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ControlPlaneInstalledState } from "../packages/installer/src/controlPlaneState.js";
import type { PrepareControlPlaneOptions, connectControlPlane } from "../packages/control-plane/admin/src/controlPlaneSetup.js";
import { removalPaths } from "./local-uninstall/paths.ts";
import { checked, command, type Command } from "./local-uninstall/command.ts";
import { privateDirectory, privateJson, replaceJson } from "./local-control-plane/files.ts";
import { metadata, object } from "./local-uninstall/files.ts";
import { preparedServiceImages, services } from "./local-control-plane/images.ts";
import { ensureLocalImageRegistry } from "./local-control-plane/registry.ts";

export interface LocalControlPlaneOperations {
  current(state: string): Promise<ControlPlaneInstalledState | undefined>;
  prepare(options: PrepareControlPlaneOptions): Promise<unknown>;
  deploy(config: string, state: string, backups: string, existing: boolean): Promise<void>;
  connect(directory: string, output: string): ReturnType<typeof connectControlPlane>;
  select(directory: string): Promise<void>;
  registry(data: string, run: Command): Promise<string>;
}
async function defaultOperations(paths: ReturnType<typeof removalPaths>, env: NodeJS.ProcessEnv): Promise<LocalControlPlaneOperations> {
  const require = createRequire(join(paths.hostPlugins, "package.json"));
  const admin = await import(pathToFileURL(require.resolve("@slop-lab/dim-control-plane-admin")).href) as typeof import("../packages/control-plane/admin/src/index.js");
  const native = await import(pathToFileURL(require.resolve("@slop-lab/dim-host-plugin-native-git")).href) as typeof import("../packages/host/plugins/native-git/src/index.js");
  if (!env.DIM_LOCAL_INSTALLER) throw new Error("matching local installer facade is required");
  const facade = pathToFileURL(await realpath(env.DIM_LOCAL_INSTALLER));
  const state = await import(new URL("./controlPlaneState.js", facade).href) as typeof import("../packages/installer/src/controlPlaneState.js");
  const locking = await import(new URL("./controlPlaneLock.js", facade).href) as typeof import("../packages/installer/src/controlPlaneLock.js");
  const installer = await import(new URL("./controlPlaneInstall.js", facade).href) as typeof import("../packages/installer/src/controlPlaneInstall.js");
  const configs = await import(new URL("./controlPlaneConfig.js", facade).href) as typeof import("../packages/installer/src/controlPlaneConfig.js");
  const sources = await import(new URL("./controlPlaneSources.js", facade).href) as typeof import("../packages/installer/src/controlPlaneSources.js");
  return {
    async current(root) { const lock = await locking.acquireControlPlaneStateLock(root); try { return await state.readControlPlaneInstalledState(lock); } finally { await lock.close(); } },
    prepare: admin.prepareControlPlane,
    async deploy(configPath, stateRoot, backups, existing) {
      if (!existing) { await installer.installControlPlane({ configPath, stateRoot }); return; }
      const config = await configs.readControlPlaneConfig(configPath);
      const selectedSources = await sources.readControlPlaneSources(config);
      const lock = await locking.acquireControlPlaneStateLock(stateRoot);
      let unchanged: boolean;
      try {
        const prior = await state.readControlPlaneInstalledState(lock);
        unchanged = prior !== undefined && state.isControlPlaneInstalledInput(prior, config, selectedSources);
      } finally { await lock.close(); }
      if (unchanged) { await installer.installControlPlane({ configPath, stateRoot }); return; }
      // Development can change formats in one direction. Always checkpoint both
      // stopped volumes before an update; never weaken the published installer.
      await new Promise<void>((done, reject) => {
        const child = spawn(process.execPath, ["--import", join(paths.repository, "tests/node_modules/tsx/dist/loader.mjs"), "--conditions=dim-source",
          join(paths.repository, "scripts/upgrade-local-control-plane.ts"), configPath, stateRoot, backups], { stdio: "inherit", env });
        child.once("error", reject);
        child.once("close", (status) => status === 0 ? done() : reject(new Error(`local control-plane checkpoint update failed (${status}); inspect retained recovery evidence`)));
      });
    },
    connect: (directory, output) => admin.connectControlPlane(directory, { outputDirectory: output }),
    select: (directory) => native.saveControlPlaneSelection({ hostConnectionFile: join(directory, "host.json"), importerConnectionFile: join(directory, "importer.json") }),
    registry: ensureLocalImageRegistry
  };
}
export async function installLocalControlPlane(bundle: string, env: NodeJS.ProcessEnv = process.env, run: Command = command, operations?: LocalControlPlaneOperations): Promise<void> {
  const paths = removalPaths(env), ops = operations ?? await defaultOperations(paths, env);
  const images = await preparedServiceImages(bundle, run);
  const prior = await ops.current(paths.controlPlane);
  const registry = env.DIM_LOCAL_IMAGE_REGISTRY ?? await ops.registry(paths.data, run);
  if (!/^(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]{1,5})?$/.test(registry)) throw new Error("DIM_LOCAL_IMAGE_REGISTRY must be a registry host[:port], without a path or credentials");
  const pinned = {} as Record<typeof services[number], string>;
  for (const service of services) {
    const name = service === "native-git" ? "git-service" : "execution-service";
    const tag = `${registry}/dim/${name}:local-${images[service].id.slice(7)}`;
    await checked(run, "docker", ["tag", images[service].id, tag]);
    console.log(`[install] publish prepared ${service} image to ${registry}`);
    await checked(run, "docker", ["push", tag]);
    const digests: unknown = JSON.parse(await checked(run, "docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", tag]));
    const prefix = `${registry}/dim/${name}@sha256:`;
    const matches = Array.isArray(digests) ? digests.filter((value): value is string => typeof value === "string" && value.startsWith(prefix) && /^[0-9a-f]{64}$/.test(value.slice(prefix.length))) : [];
    if (matches.length !== 1) throw new Error(`prepared ${service} image has no unique registry digest`);
    pinned[service] = matches[0]!;
  }
  const directory = env.DIM_LOCAL_CONTROL_PLANE_SETUP ?? join(paths.configuration, "local-control-plane");
  if (!isAbsolute(directory)) throw new Error("DIM_LOCAL_CONTROL_PLANE_SETUP must be an absolute directory");
  await privateDirectory(resolve(directory, ".."));
  if (await metadata(directory)) await privateDirectory(directory);
  const configPath = join(directory, "install.json");
  let config = await privateJson(configPath);
  if (config === undefined) {
    if (prior === undefined) {
      await privateDirectory(resolve(directory, ".."));
      await ops.prepare({ directory, nativeGitImage: pinned["native-git"], executionImage: pinned.execution, hostId: "dim-local" });
    } else {
      // Adopt the attested deployed snapshots once, including all credentials,
      // upstream tokens, custom ports and worker profiles. No credential rotation.
      await privateDirectory(directory);
      for (const service of services) {
        const snapshot = service === "native-git" ? prior.snapshots.nativeGit : prior.snapshots.execution;
        await writeFile(join(directory, `${service}.json`), snapshot.config, { mode: 0o600, flag: "wx" });
        await writeFile(join(directory, `${service}-readiness.token`), snapshot.readinessToken, { mode: 0o600, flag: "wx" });
      }
      await replaceJson(configPath, { schemaVersion: 1, deploymentId: prior.record.deploymentId,
        nativeGit: { image: prior.record.nativeGitImage, configFile: join(directory, "native-git.json"), readinessTokenFile: join(directory, "native-git-readiness.token"), publish: prior.record.nativeGitPublish },
        execution: { image: prior.record.executionImage, configFile: join(directory, "execution.json"), readinessTokenFile: join(directory, "execution-readiness.token"), publish: prior.record.executionPublish } });
    }
    config = await privateJson(configPath);
  }
  const source = object(config), nativeGit = object(source.nativeGit), execution = object(source.execution);
  // An explicitly selected setup must still be the existing local deployment.
  if (prior && source.deploymentId !== prior.record.deploymentId) throw new Error("local setup selects another deployment");
  const candidate = { ...source, nativeGit: { ...nativeGit, image: pinned["native-git"] }, execution: { ...execution, image: pinned.execution } };
  const stage = join(directory, `install-candidate-${randomUUID()}.json`);
  await replaceJson(stage, candidate);
  console.log("[install] deploy Native Git and execution; existing workspaces remain running");
  await ops.deploy(stage, paths.controlPlane, join(paths.repository, ".local/backups"), prior !== undefined);
  await replaceJson(configPath, candidate);
  // Connection output is immutable and generation-bound. Reconnecting on every
  // install also repairs a previous successful deployment with a failed connect.
  const output = join(directory, `connections-${randomUUID()}`);
  const connected = await ops.connect(directory, output);
  await ops.select(connected.directory);
  await rm(stage);
  console.log(`[install] connected ${connected.hostId}; generation ${connected.generationId}`);
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [bundle] = process.argv.slice(2);
  if (!bundle || process.argv.length !== 3) throw new Error("Usage: node scripts/install-local-control-plane.ts BUNDLE");
  await installLocalControlPlane(bundle);
}
