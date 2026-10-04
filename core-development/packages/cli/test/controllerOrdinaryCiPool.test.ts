import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { hostMirrorInspection } from "../../../../core/packages/core/src/hostMirrorOwnership.js";
import {
  registryCacheInspect,
  TEST_HOST_MIRROR_OWNERSHIP,
  TEST_HOST_MIRROR_PROVIDER
} from "../../core/test/hostLifecycleFixture.js";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const JOB_IMAGE = `registry.example/dim/job@sha256:${"a".repeat(64)}`;
const RUNNER_IMAGE = `sha256:${"b".repeat(64)}`;

test("managed controller owns configured ordinary CI capacity through cleanup and release", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-ordinary-ci-"));
  const stateRoot = path.join(root, "state");
  const configHome = path.join(root, "config");
  const pluginHome = path.join(root, "plugins");
  const runtimeRoot = path.join(root, "runtime");
  const workspaceSocket = path.join(runtimeRoot, "workspace.sock");
  const adminSocket = path.join(runtimeRoot, "admin.sock");
  const agentSocket = path.join(runtimeRoot, "agent.sock");
  const dockerEvents = path.join(root, "docker-events.jsonl");
  const poolEvents: string[] = [];
  let claimAvailable = true;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://control").pathname;
    if (pathname === "/healthz") return json(response, 200, { ok: true, serviceId: "pool-main", jobImage: JOB_IMAGE });
    if (pathname === "/api/v1/version") return json(response, 200, { version: "test" });
    if (pathname === "/api/v1/user") {
      const authorization = request.headers.authorization ?? "";
      const login = Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString().split(":")[0] ?? "";
      return json(response, 200, { login, is_admin: login === "admin" });
    }
    if (pathname === "/api/v1/orgs/dim-alpha" && request.method === "GET") return json(response, 200, { id: 41, username: "dim-alpha" });
    if (pathname === "/api/v1/orgs/dim-alpha/actions/runners/registration-token") return json(response, 200, { token: "ephemeral-registration-token" });
    const authorized = request.headers.authorization === "Bearer host-token" && request.headers["x-dim-host"] === "host-a";
    if (pathname.startsWith("/v1/claims") && !authorized) return json(response, 403, { error: "foreign host identity" });
    if (pathname === "/v1/claims" && request.method === "POST") {
      try {
        await Promise.all([workspaceSocket, adminSocket, agentSocket].map((socket) => access(socket)));
      } catch {
        poolEvents.push("claim-before-listeners");
      }
      poolEvents.push("claim");
      if (!claimAvailable) return void response.writeHead(204).end();
      claimAvailable = false;
      return json(response, 200, claim());
    }
    if (pathname === "/v1/claims/claim-controller/renew") return json(response, 200, { leaseMilliseconds: 60_000 });
    if (pathname === "/v1/claims/claim-controller/release") {
      poolEvents.push("release");
      return void response.writeHead(204).end();
    }
    return void response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await Promise.all([
    mkdir(path.join(configHome, "dim"), { recursive: true }),
    mkdir(path.join(root, "bin"), { recursive: true }),
    installProviderPlugin(pluginHome)
  ]);
  await new LifecycleState(stateRoot).writeHostMirrorOwnership(TEST_HOST_MIRROR_OWNERSHIP);
  await writeFile(path.join(configHome, "dim", "config.json"), JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
  const giteaFile = path.join(root, "gitea.json");
  const poolFile = path.join(root, "pool.json");
  await writeFile(giteaFile, JSON.stringify({
    schemaVersion: 1, transport: "loopback-http", hostId: "host-a",
    apiBaseUrl: `${endpoint}/api/v1`, hostBaseUrl: endpoint, workspaceBaseUrl: endpoint, runnerBaseUrl: endpoint,
    credentials: {
      adminUsername: "admin", adminPassword: "admin-password", writerUsername: "writer",
      writerPassword: "writer-password", maintainerUsername: "maintainer", maintainerPassword: "maintainer-password"
    },
    projects: { alpha: { id: "project-a", gitNamespace: "dim-alpha", giteaOrganizationId: 41 } }
  }), { mode: 0o600 });
  await writeFile(poolFile, JSON.stringify({
    schemaVersion: 3, transport: "loopback-http", endpoint, hostId: "host-a", token: "host-token",
    capacities: ["primary"], expectedServiceId: "pool-main", expectedJobImage: JOB_IMAGE
  }), { mode: 0o600 });
  const docker = path.join(root, "bin", "docker");
  await writeFile(docker, fakeDockerSource(dockerEvents), { mode: 0o755 });
  await chmod(docker, 0o755);
  const env = {
    ...process.env,
    DIM_CI_RUNNER_IMAGE: RUNNER_IMAGE,
    DIM_GITEA_CONNECTION_FILE: giteaFile,
    DIM_ORDINARY_CI_POOL_CONNECTION_FILE: poolFile,
    DIM_PLUGIN_HOME: pluginHome,
    DIM_STATE_ROOT: stateRoot,
    HOME: root,
    PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: runtimeRoot
  };
  const controller = spawn(process.execPath, ["--import", tsxImport, cli, "controller", "serve",
    "--socket", workspaceSocket, "--admin-socket", adminSocket,
    "--agent-socket", agentSocket, "--pid-file", path.join(runtimeRoot, "controller.pid")
  ], { cwd: packageDirectory, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  controller.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await waitFor(
      () => poolEvents.includes("release"),
      async () => `${stderr}\nDocker:\n${await readFile(dockerEvents, "utf8").catch(() => "no calls")}`
    );
    const denied = await fetch(`${endpoint}/v1/claims`, {
      method: "POST",
      headers: { authorization: "Bearer foreign-token", "content-type": "application/json", "x-dim-host": "foreign" },
      body: JSON.stringify({ hostId: "foreign", capacity: "primary", requestId: "foreign" })
    });
    assert.equal(denied.status, 403);
    const events = (await readFile(dockerEvents, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(
      events.some((args) => args[0] === "run" && args.includes("GITEA_RUNNER_ONCE=1")),
      `${stderr}\n${JSON.stringify(events)}`
    );
    assert.ok(events.some((args) => args[0] === "container" && args[1] === "rm"));
    assert.doesNotMatch(JSON.stringify(events), /host-token|admin-password|writer-password|maintainer-password/);
    assert.equal(poolEvents.includes("claim-before-listeners"), false);
    assert.deepEqual(poolEvents.slice(0, 2), ["claim", "release"]);
    controller.kill("SIGTERM");
    await once(controller, "exit");
    assert.equal(controller.exitCode, 0, stderr);
  } finally {
    if (controller.exitCode === null) {
      controller.kill("SIGKILL");
      await once(controller, "exit");
    }
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

function claim(): Readonly<Record<string, unknown>> {
  return {
    claimId: "claim-controller", admissionId: "a".repeat(64), serviceId: "pool-main", jobId: 101,
    projectId: "project-a", projectName: "alpha", organization: "dim-alpha", organizationId: 41,
    sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64),
    jobImage: JOB_IMAGE, runnerLabels: ["dim-ordinary"], leaseMilliseconds: 60_000
  };
}

function fakeDockerSource(eventsFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "network") process.stdout.write(${JSON.stringify(`${hostMirrorInspection("control-network", TEST_HOST_MIRROR_OWNERSHIP)}\n`)});
else if (args[0] === "volume") process.stdout.write(${JSON.stringify(`${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`)});
else if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-registry-cache") process.stdout.write(${JSON.stringify(registryCacheInspect(TEST_HOST_MIRROR_PROVIDER.dockerImage))});
else if (args[0] === "container" && args[1] === "inspect") {
  const calls = fs.readFileSync(${JSON.stringify(eventsFile)}, "utf8").trim().split("\\n").map(JSON.parse);
  const launch = calls.find((call) => call[0] === "run" && call.includes("dim.resource=ci-ordinary-job"));
  if (launch === undefined) {
    process.stderr.write("Error: No such container: " + args[2]);
    process.exitCode = 1;
  } else {
    const labels = launch.flatMap((value, index) => value === "--label" ? [launch[index + 1].split("=").slice(1).join("=")] : []);
    process.stdout.write("owned-container-id|" + labels.join("|") + "\\n");
  }
}
`;
}

async function installProviderPlugin(pluginHome: string): Promise<void> {
  const name = "test-host-mirror-provider";
  const directory = path.join(pluginHome, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(pluginHome, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [name] }));
  await writeFile(path.join(pluginHome, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
  await writeFile(path.join(directory, "index.js"), `export const plugin = {
  name: ${JSON.stringify(name)}, apiVersion: 4, register(host) {
    host.registerExtension("dim.host-mirror-provider", "host", ${JSON.stringify(TEST_HOST_MIRROR_PROVIDER)});
  }
};\n`);
}

async function waitFor(observed: () => boolean, diagnostics: () => Promise<string>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (observed()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for managed ordinary CI execution\n${await diagnostics()}`);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
