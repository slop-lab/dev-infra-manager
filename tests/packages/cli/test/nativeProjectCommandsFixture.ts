import assert from "node:assert/strict";
import { dimWorkflowCompiler } from "@slop-lab/dim-plugin-control-plane-ci-workflows";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createNodeNativeGitRootImporterClient,
  NativeProjectDraftStore, NativeProjectPendingStore, parseNativeControlPlaneConnection
} from "../../../../core/packages/managed/src/index.js";
import { compileNativeRepositoryBootstrapPolicy } from "../../../../core/packages/managed/src/nativeRootBootstrapPolicy.js";
import { parseNativeGitBundleConfig } from "../../../../plugin-control-plane-native-git/src/bundle-config.js";
import { configuredNativeGitBundleServer,
  type NativeGitBundleServer } from "../../../../plugin-control-plane-native-git/src/native-bundle-server.js";
import { bundleSecrets, idleNativeConfig } from "../../native-git/test/bundleConfigFixture.js";
import { prepareNativeProjectFixtureRootForRemoval } from "./nativeProjectFixtureCleanup.js";
import type { NativeFixture, NativeFixtureOptions } from "./nativeProjectCommandsFixtureTypes.js";

export type { NativeFixture } from "./nativeProjectCommandsFixtureTypes.js";

const runFile = promisify(execFile);
const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = createRequire(import.meta.url).resolve("tsx");
const roots: string[] = [];
const services: NativeGitBundleServer[] = [];
const generationId = "a".repeat(64);
const nextGenerationId = "b".repeat(64);
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const nextActivationToken = Buffer.alloc(32, 43).toString("base64url");
const importer = { hostId: "host-a", username: "project-root-importer-a",
  password: bundleSecrets.projectRootImporter } as const;
const policy = compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main",
  review: { requiredReviewerIds: ["owner"], pathReviewerRules: [],
    requiredJobs: [], ciRepositoryIds: ["root"] } });

export async function cleanupNativeProjectFixtures(): Promise<void> {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await prepareNativeProjectFixtureRootForRemoval(root);
    await rm(root, { recursive: true, force: true });
  }));
}

export async function nativeFixture(options: NativeFixtureOptions = {}): Promise<NativeFixture> {
  const root = await mkdtemp("/tmp/dim-native-cli-");
  roots.push(root);
  const serviceRoot = join(root, "service");
  const stateRoot = join(root, "state");
  const configHome = join(root, "config");
  const configDirectory = join(configHome, "dim");
  await runFile("mkdir", ["-m", "700", serviceRoot, stateRoot, configHome]);
  await runFile("mkdir", ["-m", "700", configDirectory]);
  await writeFile(join(configDirectory, "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`, { mode: 0o600 });
  const frozenLeaseNow = Date.now();
  const workspaceWriteLeaseClock = options.workspaceWriteLeaseClock ?? (() => frozenLeaseNow);
  let leaseClockOffset = 0;
  const leaseClock = (): number => workspaceWriteLeaseClock() + leaseClockOffset;
  let readinessRequests = 0;
  const countReadinessRequest = (): void => { readinessRequests += 1; };
  let service = await startNativeGit(serviceRoot, leaseClock, countReadinessRequest,
    generationId, activationToken);
  const bundle = await createRootBundle(root);
  const bundlePath = join(root, "root.bundle");
  await writeFile(bundlePath, bundle.bytes, { mode: 0o600 });
  await chmod(bundlePath, 0o600);
  const registrarPath = join(root, "registrar.json");
  await writeFile(registrarPath, JSON.stringify({ schemaVersion: 1, endpoint: service.origin,
    serviceId: "native-main", hostId: importer.hostId, generationId,
    credential: { username: "registrar-a", password: bundleSecrets.projectRegistrar } }), { mode: 0o600 });
  const importerPath = join(root, "importer.json");
  await writeFile(importerPath, JSON.stringify({ schemaVersion: 1, endpoint: service.origin,
    serviceId: "native-main", role: "operator-root-importer", hostId: importer.hostId, generationId,
    credential: { username: importer.username, password: importer.password } }), { mode: 0o600 });
  const projects = new NativeProjectPendingStore(stateRoot);
  await projects.create({ name: "acme", projectId: "project-a", ownerHostId: importer.hostId });
  if (options.seedImportedDraft !== false) {
    await service.prepareProject(generationId, importer.hostId, {
      serviceId: "native-main", projectId: "project-a", repositoryId: "root"
    });
    const client = await createNodeNativeGitRootImporterClient(importerPath);
    const receipt = await client.importRepository({ serviceId: "native-main", projectId: "project-a",
      repositoryId: "root", protectedRef: policy.protectedRef, expectedCommit: bundle.commit,
      policy: policy.reviewPolicy, bundlePath }, AbortSignal.timeout(20_000));
    const drafts = new NativeProjectDraftStore(stateRoot);
    await drafts.claim({ name: "acme", projectId: "project-a", ownerHostId: importer.hostId,
      generationId, expectedCommit: bundle.commit, expectedTree: bundle.tree, bundlePath, ...policy });
    await drafts.markRepositoryImported("acme", "root", receipt);
    await projects.admitRepository("acme", "root", client, parseNativeControlPlaneConnection(controlConnection(service.origin, importer.hostId, generationId)), AbortSignal.timeout(20_000));
  }
  const controlPath = join(root, "control.json");
  await writeFile(controlPath,
    JSON.stringify(controlConnection(service.origin, importer.hostId, generationId)), { mode: 0o600 });
  const environment = cleanEnvironment();
  environment.XDG_CONFIG_HOME = configHome;
  environment.DIM_STATE_ROOT = stateRoot;
  environment.DIM_MANAGED_STATE_ROOT = stateRoot;
  environment.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE = controlPath;
  environment.DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE = importerPath;
  return { stateRoot, serviceRoot, sourceRepository: bundle.source, registrarPath, importerPath, controlPath,
    commit: bundle.commit, tree: bundle.tree, environment,
    advanceLeaseClock(milliseconds) { leaseClockOffset += milliseconds; },
    leaseClock,
    readinessRequests() { return readinessRequests; },
    importGenerationId: generationId,
    currentGenerationId: nextGenerationId,
    async restartNativeGit() {
      const address = service.server.address();
      assert.ok(address !== null && typeof address !== "string");
      const index = services.indexOf(service);
      if (index >= 0) services.splice(index, 1);
      await service.close();
      service = await startNativeGit(serviceRoot, leaseClock, countReadinessRequest,
        generationId, activationToken, address.port);
    },
    async rolloverNativeGit(publishConnection = true) {
      const address = service.server.address();
      assert.ok(address !== null && typeof address !== "string");
      const index = services.indexOf(service);
      if (index >= 0) services.splice(index, 1);
      await service.close();
      service = await startNativeGit(serviceRoot, leaseClock, countReadinessRequest,
        nextGenerationId, nextActivationToken, address.port);
      if (publishConnection) {
        await writeFile(controlPath,
          JSON.stringify(controlConnection(service.origin, importer.hostId, nextGenerationId)), { mode: 0o600 });
      }
    },
    async publishCurrentGeneration() {
      await writeFile(controlPath,
        JSON.stringify(controlConnection(service.origin, importer.hostId, nextGenerationId)), { mode: 0o600 });
    } };
}

export async function rewriteJson(
  path: string,
  update: (value: Record<string, unknown>) => object
): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify(update(value)), { mode: 0o600 });
}

export async function runCli(args: readonly string[], environment: NodeJS.ProcessEnv,
  nodeArguments: readonly string[] = []) {
  const child = spawn(process.execPath, ["--import", tsxImport, ...nodeArguments, cli, ...args], {
    cwd: packageDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

async function startNativeGit(
  stateDirectory: string,
  now: () => number,
  onReadinessRequest: () => void,
  servingGenerationId: string,
  servingActivationToken: string,
  port = 0
) {
  const configuration = idleNativeConfig();
  const { stdout: gitIdentity } = await runFile(configuration.gitExecutable, ["--version"]);
  const gitVersion = gitIdentity.trim().replace(/^git version /, "");
  const service = await configuredNativeGitBundleServer({
    workflowCompiler: dimWorkflowCompiler,
    config: parseNativeGitBundleConfig({ ...configuration, gitVersion,
      projectRegistrars: [{ hostId: "host-a", username: "registrar-a",
        password: bundleSecrets.projectRegistrar }],
      projectRootImporters: [importer],
      projectRootReadIssuers: [{ hostId: "host-a", username: "project-root-read-issuer-a",
        password: bundleSecrets.projectRootReadIssuer }],
      workspaceWriteIssuers: [{ hostId: "host-a", username: "workspace-write-issuer-a",
        password: bundleSecrets.workspaceWriteIssuer }],
      humanReviewers: [{ reviewerId: "owner", username: "human-reviewer-owner",
        password: bundleSecrets.humanReviewer }] }),
    stateDirectory,
    readinessToken: Buffer.alloc(32, 41).toString("base64url"),
    activationToken: servingActivationToken,
    expectedGenerationId: servingGenerationId,
    workspaceWriteLeaseClock: now
  });
  services.push(service);
  service.server.on("request", (request) => {
    if (request.url?.endsWith("/workspace-readiness") === true) onReadinessRequest();
  });
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(port, "127.0.0.1", () => {
      service.server.off("error", reject);
      resolve();
    });
  });
  const address = service.server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/v1/activation`, { method: "POST",
    headers: { authorization: `Bearer ${servingActivationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: servingGenerationId }) });
  assert.equal(response.status, 200);
  return { ...service, origin };
}

async function createRootBundle(root: string) {
  const source = join(root, "source");
  const path = join(root, "source.bundle");
  await runFile("/usr/bin/git", ["init", "--initial-branch=main", source]);
  await runFile("mkdir", ["-m", "700", join(source, ".dim")]);
  await writeFile(join(source, ".dim", "repos.yml"), `schemaVersion: 1
repositories:
  root: {url: https://example.test/root.git, root: true, ref: main, protect: [main]}
nativeReview:
  requiredReviewerIds: [owner]
  pathReviewerRules: []
  requiredJobs: []
  ciRepositoryIds: [root]
`);
  await writeFile(join(source, "README.md"), "native CLI root\n");
  await runFile("/usr/bin/git", ["-C", source, "add", "."]);
  await runFile("/usr/bin/git", ["-C", source, "-c", "user.name=DIM Test", "-c",
    "user.email=dim@example.invalid", "commit", "-m", "root"]);
  const commit = (await runFile("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const tree = (await runFile("/usr/bin/git", ["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  await runFile("/usr/bin/git", ["-C", source, "bundle", "create", path, "refs/heads/main"]);
  return { source, bytes: await readFile(path), commit, tree };
}

function controlConnection(endpoint: string, hostId: string, servingGenerationId: string): object {
  return { schemaVersion: 1, hostId,
    nativeGit: { transport: "loopback-http", endpoint, serviceId: "native-main",
      generationId: servingGenerationId,
      workspaceWriteIssuer: { username: "workspace-write-issuer-a", password: bundleSecrets.workspaceWriteIssuer },
      rootReadIssuer: { username: "project-root-read-issuer-a", password: bundleSecrets.projectRootReadIssuer } } };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of ["DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", "DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE"]) {
    delete environment[name];
  }
  return environment;
}
