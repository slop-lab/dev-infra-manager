import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ControlPlaneExtension, ControlPlanePlugin } from "../../packages/control-plane/core/src/plugin-api.js";
import { loadExampleRecipe, resolveExamplePath } from "./recipe.ts";

const root = resolve(import.meta.dirname, "../..");
const facade = process.env.DIM_EXAMPLE_DIM_BIN;
const data = process.env.DIM_DATA_HOME;
if (!facade || !data) throw new Error("VM examples require their isolated installed facade and DIM_DATA_HOME");
const host = createRequire(join(data, "runtime/current/package.json"));
const remoteEndpoint = process.env.DIM_EXAMPLE_REMOTE_ENDPOINT;
const controlPlane = remoteEndpoint === undefined ? createRequire(join(data, "control-plane/runtime/current/package.json")) : undefined;
async function load<T>(resolver: NodeJS.Require, name: string): Promise<T> {
  return import(pathToFileURL(resolver.resolve(name)).href) as Promise<T>;
}
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (status, signal) => status === 0 ? resolve() : reject(new Error(`example command failed (${signal ?? status})`)));
  });
}

const cancellation = new AbortController();
const { prepareControlPlane, connectControlPlane } = await load<typeof import("../../packages/control-plane/admin/src/index.js")>(host, "@slop-lab/dim-control-plane-admin");
const { parseManagedGitServiceConfig, repositoryConfiguration } = await load<typeof import("../../packages/control-plane/admin/src/service-pair.js")>(host, "@slop-lab/dim-control-plane-admin/service-pair");
const repositoryModule = controlPlane === undefined ? undefined : await load<typeof import("../../packages/control-plane/plugins/git-repositories/src/index.js")>(controlPlane, "@slop-lab/dim-control-plane-plugin-git-repositories");
const scratch = await mkdtemp(join(tmpdir(), "dim-examples-services-"));
let service: Awaited<ReturnType<NonNullable<typeof repositoryModule>["configuredNativeGitBundleServer"]>> | undefined;
try {
  if (remoteEndpoint !== undefined) {
    const setup = process.env.DIM_EXAMPLE_REMOTE_SETUP;
    if (!setup || !process.env.DIM_EXAMPLE_REMOTE_CI_ENDPOINT) throw new Error("separate control-plane operator directory and CI endpoint required");
    const connected = await connectControlPlane(setup, { endpoint: remoteEndpoint, executionEndpoint: process.env.DIM_EXAMPLE_REMOTE_CI_ENDPOINT });
    process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE = join(connected.directory, "host.json");
    process.env.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE = join(connected.directory, "importer.json");
    console.log("Host-only installed runtime connected to the separate control-plane VM");
  } else {
  const directories: unknown = JSON.parse(await readFile(join(root, "examples/catalog.json"), "utf8"));
  if (!Array.isArray(directories) || !directories.every((entry): entry is string => typeof entry === "string")) throw new Error("invalid example catalog");
  const recipes = await Promise.all(directories.map((entry) => loadExampleRecipe(resolveExamplePath({ directory: join(root, "examples") }, entry))));
  const selected = new Set(recipes.filter((recipe) => recipe.commands["verify-vm"])
    .flatMap((recipe) => recipe.plugins.controlPlane.map((specifier) => specifier.slice(0, specifier.lastIndexOf("@")))));
  const setup = join(scratch, "operator");
  await prepareControlPlane({ directory: setup, nativeGitImage: `example/native@sha256:${"a".repeat(64)}`,
    executionImage: `example/ci@sha256:${"b".repeat(64)}` });
  const parsed = parseManagedGitServiceConfig(JSON.parse(await readFile(join(setup, "native-git.json"), "utf8")));
  const config = { ...parsed, gitVersion: execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim().replace(/^git version /, "") };
  await writeFile(join(setup, "native-git.json"), JSON.stringify(config), { mode: 0o600 });
  const configurations: Readonly<Record<string, unknown>> = {
    "@slop-lab/dim-control-plane-plugin-git-review": { humanReviewers: config.humanReviewers },
    "@slop-lab/dim-control-plane-plugin-git-merge-policy": { hostPromoters: config.hostPromoters },
    "@slop-lab/dim-control-plane-plugin-git-ci": config.ci,
    "@slop-lab/dim-control-plane-plugin-ci-workflows": {}
  };
  const extensions: ControlPlaneExtension[] = [];
  for (const name of selected) {
    if (name === "@slop-lab/dim-control-plane-plugin-git-repositories" || name === "@slop-lab/dim-control-plane-plugin-execution-scheduler") continue;
    if (!(name in configurations)) throw new Error(`VM service setup has no configuration for declared plugin ${name}`);
    const { controlPlanePlugin } = await load<{ controlPlanePlugin: ControlPlanePlugin }>(controlPlane!, name);
    const prepared = await controlPlanePlugin.configure(configurations[name]);
    extensions.push(...prepared.extensions ?? []);
  }
  const generationId = "c".repeat(64), activationToken = Buffer.alloc(32, 71).toString("base64url");
  service = await repositoryModule!.configuredNativeGitBundleServer({ config: repositoryConfiguration(config),
    stateDirectory: join(scratch, "repositories"), readinessToken: Buffer.alloc(32, 72).toString("base64url"),
    activationToken, expectedGenerationId: generationId, extensions, signal: cancellation.signal });
  const endpoint = await service.listen("127.0.0.1", 0);
  const connected = await connectControlPlane(setup, { endpoint });
  const activated = await fetch(`${endpoint}/v1/activation`, { method: "POST", headers: {
    authorization: `Bearer ${activationToken}`, "content-type": "application/json"
  }, body: JSON.stringify({ schemaVersion: 1, generationId }) });
  if (activated.status !== 200) throw new Error("example repository activation failed");
  process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE = join(connected.directory, "host.json");
  process.env.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE = join(connected.directory, "importer.json");
  }
  const work = join(scratch, "examples"); await mkdir(work);
  process.env.DIM_EXAMPLE_WORK = work;
  await run(process.execPath, [join(root, "scripts/examples/run.ts"), "all", "verify-vm"]);
} finally {
  try { await run(facade, ["controller", "stop"]); }
  finally {
    cancellation.abort();
    try { await service?.close(); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
