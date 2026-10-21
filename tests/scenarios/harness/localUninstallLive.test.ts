import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createCommand, checked } from "../../../scripts/local-uninstall/command.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "../../../scripts/local-uninstall/plan.ts";

const image = "docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
it.skipIf(process.env.DIM_TEST_LOCAL_UNINSTALL !== "1")("removes an isolated real installation and owned Docker resources, then installs and removes again", async () => {
  const bundle = resolve(process.env.DIM_TEST_LOCAL_BUNDLE ?? join(import.meta.dirname, "../../../.local/dim-packages"));
  const tarballs = (await readdir(bundle)).filter((name) => /^slop-lab-dim-installer-.*\.tgz$/.test(name));
  expect(tarballs).toHaveLength(1);
  const root = await mkdtemp(join(tmpdir(), "dim-uninstall-live-")), home = join(root, "home");
  const token = randomUUID(), foreignContainer = `dim-uninstall-foreign-${token}`, foreignVolume = `${foreignContainer}-data`;
  const id = randomUUID(), prefix = `dim-workspace-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
  const data = join(home, ".local/share/dim"), runtime = join(home, "run");
  const cacheNamespace = `dim-cache-test-${token.slice(0, 8)}`, cacheNetwork = `${cacheNamespace}-network`, cacheContainer = `${cacheNamespace}-docker`;
  const cacheKinds = ["docker", "npm", "pypi", "apt"];
  const ledger = { schemaVersion: 2, serviceId: randomBytes(32).toString("base64url"), resourceIds: Object.fromEntries(["network", "cache:docker", ...cacheKinds.map((kind) => `data:${kind}`)].map((role) => [role, randomBytes(32).toString("base64url")])) };
  const cacheLabels = (role: string) => Object.entries({ "dim.managed": "true", "dim.owner": "dim", "dim.service-id": ledger.serviceId, "dim.resource": role, "dim.resource-id": ledger.resourceIds[role]! }).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const originalPath = process.env.PATH ?? "";
  const environment: Record<string, string> = {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_RUNTIME_DIR: runtime,
    DIM_DATA_HOME: data, DIM_CONFIG_PATH: join(home, ".config/dim/config.json"), DIM_INSTALL_PREFIX: join(home, ".local"),
    DIM_STATE_ROOT: join(home, ".local/state/dim"), DIM_MANAGED_STATE_ROOT: join(home, ".local/state/dim/managed"),
    DIM_PLUGIN_HOME: join(data, "runtime/current"), DIM_CONTROL_PLANE_PLUGIN_HOME: join(data, "control-plane/runtime/current"),
    MISE_CONFIG_DIR: join(home, ".config/mise"), MISE_DATA_DIR: join(home, ".local/share/mise"),
    MISE_CACHE_DIR: join(home, ".cache/mise"), MISE_STATE_DIR: join(home, ".local/state/mise"),
    MISE_GLOBAL_CONFIG_FILE: join(home, ".config/mise/config.toml"), MISE_YES: "1",
    PATH: `${dirname(process.execPath)}:${originalPath}`, npm_config_cache: join(home, ".cache/npm")
  };
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  // Configuration from the operator's current workspace must not select another installation.
  for (const key of ["DIM_CONTROLLER_SOCKET", "DIM_ADMIN_CONTROLLER_SOCKET", "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", "DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE", "MISE_CONFIG_FILE"]) vi.stubEnv(key, undefined);
  const runEnv: NodeJS.ProcessEnv = { ...process.env, ...environment };
  for (const key of ["DIM_CONTROLLER_SOCKET", "DIM_ADMIN_CONTROLLER_SOCKET", "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", "DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE", "MISE_CONFIG_FILE"]) delete runEnv[key];
  for (const key of Object.keys(runEnv)) if (key.startsWith("__MISE_")) delete runEnv[key];
  const isolatedCommand = createCommand(runEnv);
  const command: import("../../../scripts/local-uninstall/command.ts").Command = (file, args) => isolatedCommand(file, file === "mise" && args[0] !== "--version" ? ["--cd", home, ...args] : args);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const docker = async (args: readonly string[]) => checked(command, "docker", args);
  const cleanupDocker = async () => {
    await command("docker", ["container", "rm", "--force", prefix, foreignContainer, cacheContainer]);
    for (const kind of cacheKinds) await command("docker", ["volume", "rm", `${cacheNamespace}-${kind}-data`]);
    await command("docker", ["network", "rm", cacheNetwork]);
    for (const name of [foreignVolume, ...["home", "checkout", "docker", "tmp"].map((role) => `${prefix}-${role}`)]) await command("docker", ["volume", "rm", name]);
    await command("docker", ["network", "rm", prefix]);
  };
  try {
    await checked(command, "mise", ["--version"]);
    await docker(["image", "inspect", image]);
    await docker(["volume", "create", foreignVolume]);
    await docker(["run", "--detach", "--name", foreignContainer, "--mount", `type=volume,source=${foreignVolume},target=/foreign`, image, "node", "-e", "setInterval(() => {}, 1000)"]);
    const paths = removalPaths();
    for (let cycle = 0; cycle < 2; cycle++) {
      const facadeRoot = join(data, "installers", `live-${cycle}`);
      await mkdir(facadeRoot, { recursive: true, mode: 0o700 });
      await checked(command, "npm", ["install", "--prefix", facadeRoot, "--ignore-scripts", "--no-audit", "--no-fund", join(bundle, tarballs[0]!)]);
      const facade = join(facadeRoot, "node_modules/.bin/dim");
      await checked(command, facade, ["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"]);
      const coordinate = `npm:@slop-lab/dim-installer@0.10.0-uninstall-live-${cycle}`;
      await checked(command, "mise", ["link", coordinate, facadeRoot]);
      await checked(command, "mise", ["use", "--global", "--raw", coordinate]);
      const listing = await checked(command, "mise", ["ls", "--json", "npm:@slop-lab/dim-installer"]);
      expect(JSON.parse(listing)).toEqual(expect.arrayContaining([expect.objectContaining({ version: `0.10.0-uninstall-live-${cycle}`, installed: true })]));
      const cacheFile = join(paths.state, "plugins/cache-server/services", `cache-${cacheNamespace}.json`);
      if (cycle === 0) {
        await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
        await writeFile(cacheFile, JSON.stringify(ledger), { mode: 0o600 });
        for (const kind of cacheKinds) await docker(["volume", "create", ...cacheLabels(`data:${kind}`), `${cacheNamespace}-${kind}-data`]);
      } else expect(JSON.parse(await checked(command, "node", ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", cacheFile]))).toEqual(ledger);
      await docker(["network", "create", ...cacheLabels("network"), cacheNetwork]);
      const cacheMounts = cacheKinds.flatMap((kind) => ["--mount", `type=volume,source=${cacheNamespace}-${kind}-data,target=/cache/${kind}`]);
      await docker(["run", "--detach", "--name", cacheContainer, "--network", cacheNetwork, ...cacheLabels("cache:docker"), ...cacheMounts, image, "node", "-e", "setInterval(() => {}, 1000)"]);
      if (cycle === 0) await docker(["exec", cacheContainer, "node", "-e", `for (const kind of ${JSON.stringify(cacheKinds)}) require('node:fs').writeFileSync('/cache/'+kind+'/marker', '${token}')`]);
      else await docker(["exec", cacheContainer, "node", "-e", `for (const kind of ${JSON.stringify(cacheKinds)}) require('node:assert/strict').equal(require('node:fs').readFileSync('/cache/'+kind+'/marker','utf8'), '${token}')`]);
      const workspaceRoot = join(paths.state, "workspaces");
      await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(workspaceRoot, "live.json"), JSON.stringify({ schemaVersion: 10, name: "live", id, runtime: "container" }), { mode: 0o600 });
      const labels = (role: string) => ["--label", "dim.managed=true", "--label", `dim.workspace-id=${id}`, "--label", `dim.resource=${role}`, "--label", "dim.workspace-schema=10"];
      await docker(["network", "create", ...labels("network"), prefix]);
      for (const role of ["home", "checkout", "docker", "tmp"]) await docker(["volume", "create", ...labels(role), `${prefix}-${role}`]);
      await docker(["run", "--detach", "--name", prefix, "--network", prefix, ...labels("container"),
        ...["home", "checkout", "docker", "tmp"].flatMap((role) => ["--mount", `type=volume,source=${prefix}-${role},target=/owned/${role}`]),
        image, "node", "-e", "setInterval(() => {}, 1000)"]);
      const plan = await createRemovalPlan(paths, command, runEnv, { keepCacheData: true });
      expect(plan.docker).toHaveLength(12);
      expect(plan.mise, JSON.stringify(plan.mise)).toContain(coordinate);
      await executeRemoval(plan, command);
      expect((await command("docker", ["container", "inspect", prefix])).status).not.toBe(0);
      expect((await command("docker", ["network", "inspect", prefix])).status).not.toBe(0);
      for (const role of ["home", "checkout", "docker", "tmp"]) expect((await command("docker", ["volume", "inspect", `${prefix}-${role}`])).status).not.toBe(0);
      expect((await command("docker", ["container", "inspect", foreignContainer])).status).toBe(0);
      expect((await command("docker", ["volume", "inspect", foreignVolume])).status).toBe(0);
      await expect(stat(paths.data)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await stat(cacheFile)).toBeDefined();
      expect((await command("docker", ["container", "inspect", cacheContainer])).status).not.toBe(0);
      expect((await command("docker", ["network", "inspect", cacheNetwork])).status).not.toBe(0);
      for (const kind of cacheKinds) expect((await command("docker", ["volume", "inspect", `${cacheNamespace}-${kind}-data`])).status).toBe(0);
      expect(JSON.parse(await checked(command, "mise", ["ls", "--json", "npm:@slop-lab/dim-installer"]))).toEqual([]);
      expect(await stat(bundle)).toBeDefined();
    }
    const purge = await createRemovalPlan(paths, command, runEnv);
    await executeRemoval(purge, command);
    for (const kind of cacheKinds) expect((await command("docker", ["volume", "inspect", `${cacheNamespace}-${kind}-data`])).status).not.toBe(0);
    await expect(stat(paths.state)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await cleanupDocker();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
