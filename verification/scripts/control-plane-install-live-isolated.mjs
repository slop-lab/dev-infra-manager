import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureAuthorityBoundaryState } from "./control-plane-install-live-evidence.mjs";
import { requiredEnvironment } from "./control-plane-install-live-fixture.mjs";
import { installWithFacade } from "./control-plane-install-live-support.mjs";

const expectedEvidence = /^isolated-no-op localhost-native=ECONNREFUSED localhost-ordinary=ECONNREFUSED facade-exit=0 generation=[0-9a-f]{64} command=installer,install,control-plane,--config network=none socket=mounted volume=same-absolute-path argv-secrets=0 env-secrets=0 output-secrets=0\n$/;

export async function runIsolatedFacadeNoOp(input) {
  const harnessVolume = input.harnessVolume ?? requiredEnvironment("HARNESS_VOLUME");
  const daemonSocketSource = input.daemonSocketSource ?? requiredEnvironment("DAEMON_SOCKET_SOURCE");
  const containerName = input.containerName ?? requiredEnvironment("ISOLATED_INSTALLER_NAME");
  const image = input.image ?? requiredEnvironment("HARNESS_IMAGE");
  const verificationId = input.verificationId ?? requiredEnvironment("VERIFICATION_ID");
  const config = JSON.parse(await readFile(join(input.root, "operator", "install.json"), "utf8"));
  const generationId = input.generationId ?? input.prior.generationId;
  const ports = input.ports ?? { nativeGit: config.nativeGit.publish.port, ordinaryCi: config.ordinaryCi.publish.port };
  const args = [
    "container", "run", "--rm", "--name", containerName,
    "--label", `org.dim.verification=${verificationId}`, "--network", "none",
    "--mount", `type=bind,src=${daemonSocketSource},dst=/run/docker.sock`,
    "--mount", `type=volume,src=${harnessVolume},dst=${input.root}`,
    "--env", `HARNESS_ROOT=${input.root}`, "--env", `ISOLATED_INSTALLER_NAME=${containerName}`,
    "--env", `EXPECTED_GENERATION=${generationId}`,
    "--env", `NATIVE_PORT=${ports.nativeGit}`, "--env", `ORDINARY_PORT=${ports.ordinaryCi}`,
    image, "node", join(input.root, "control-plane-install-live-isolated.mjs"), "child"
  ];
  assertSecretsAbsent(args.join("\0"), input.forbiddenValues);
  const beforeAuthority = input.captureAuthority === undefined
    ? await captureAuthorityBoundaryState(input.runner)
    : await input.captureAuthority();
  const result = await input.runner.run({ args, timeoutMilliseconds: 90_000, maximumOutputBytes: 1024 * 1024 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, expectedEvidence);
  assertSecretsAbsent(result.stdout + result.stderr, input.forbiddenValues);
  const residue = await input.runner.run({
    args: ["container", "inspect", containerName], timeoutMilliseconds: 5_000, maximumOutputBytes: 4_096
  });
  assert.notEqual(residue.exitCode, 0, "isolated installer container persisted after --rm");
  assert.equal(JSON.parse(await readFile(join(input.stateRoot, "install.json"), "utf8")).generationId, generationId);
  assert.deepEqual(await input.captureRuntime(), input.prior.runtime);
  assert.deepEqual(await input.captureVolumes(), input.prior.volumes);
  const installBytes = await readFile(join(input.stateRoot, "install.json"));
  const composeBytes = await readFile(join(input.stateRoot, "compose.yml"));
  assert.deepEqual(installBytes, input.prior.installBytes);
  assert.deepEqual(composeBytes, input.prior.composeBytes);
  await input.assertSentinels();
  const afterAuthority = input.captureAuthority === undefined
    ? await captureAuthorityBoundaryState(input.runner)
    : await input.captureAuthority();
  assert.deepEqual(afterAuthority, beforeAuthority);
  process.stdout.write(result.stdout);
  console.log(`isolated-no-op-outer generation=${generationId} native=${input.prior.runtime.nativeGit.id} ordinary=${input.prior.runtime.ordinaryCi.id} install-sha256=${sha256(installBytes)} compose-sha256=${sha256(composeBytes)} network-members=2 persistent-child=absent resources=unchanged`);
}

async function runChild() {
  const root = requiredEnvironment("HARNESS_ROOT");
  const operatorRoot = join(root, "operator");
  const stateRoot = join(root, "state-home", "dim", "control-plane");
  const expectedGeneration = requiredEnvironment("EXPECTED_GENERATION");
  const facade = join(root, "installer", "dim");
  const nativeConfig = JSON.parse(await readFile(join(operatorRoot, "native-git.json"), "utf8"));
  const ordinaryConfig = JSON.parse(await readFile(join(operatorRoot, "ordinary-ci.json"), "utf8"));
  const forbiddenValues = [
    nativeConfig.ordinaryCi.query.password, nativeConfig.ordinaryCi.identity.password,
    nativeConfig.ordinaryCi.attemptIssuer.password, nativeConfig.ordinaryCi.resultReporter.password,
    nativeConfig.ordinaryCi.webhook.password, ordinaryConfig.credentials.registrar.password,
    ordinaryConfig.hosts[0].hostToken,
    (await readFile(join(operatorRoot, "native-readiness.token"), "utf8")).trim(),
    (await readFile(join(operatorRoot, "ordinary-readiness.token"), "utf8")).trim()
  ];
  const { ProcessControlPlaneDockerRunner } = await import(
    pathToFileURL(join(root, "installer", "controlPlaneDocker.js")).href
  );
  const runner = new ProcessControlPlaneDockerRunner();
  const self = JSON.parse((await docker(runner, ["container", "inspect", requiredEnvironment("ISOLATED_INSTALLER_NAME")])).stdout)[0];
  assert.equal(self.HostConfig.NetworkMode, "none");
  assert.deepEqual(self.Mounts.map(({ Type, Destination }) => ({ Type, Destination })).sort(byDestination), [
    { Type: "bind", Destination: "/run/docker.sock" }, { Type: "volume", Destination: root }
  ].sort(byDestination));
  assertSecretsAbsent(JSON.stringify({ path: self.Path, args: self.Args, env: self.Config.Env }), forbiddenValues);
  const runtime = await serviceRuntime(runner);
  await assertNetworkMembers(runner);
  const nativeFailure = await localhostFailure(Number(requiredEnvironment("NATIVE_PORT")));
  const ordinaryFailure = await localhostFailure(Number(requiredEnvironment("ORDINARY_PORT")));
  assert.equal(nativeFailure, "ECONNREFUSED");
  assert.equal(ordinaryFailure, "ECONNREFUSED");
  const since = new Date(Date.now() - 1).toISOString();
  const installed = await installWithFacade({
    executable: facade, configPath: join(operatorRoot, "install.json"), stateRoot, cwd: operatorRoot,
    environment: { ...process.env, HOME: operatorRoot, XDG_STATE_HOME: join(root, "state-home") }, forbiddenOutput: forbiddenValues
  });
  assert.equal(installed.record.generationId, expectedGeneration);
  await assertReadinessEvents(runner, runtime, since, forbiddenValues);
  await assertNetworkMembers(runner);
  console.log(`isolated-no-op localhost-native=${nativeFailure} localhost-ordinary=${ordinaryFailure} facade-exit=0 generation=${installed.record.generationId} command=installer,install,control-plane,--config network=none socket=mounted volume=same-absolute-path argv-secrets=0 env-secrets=0 output-secrets=0`);
}

async function serviceRuntime(runner) {
  const result = await docker(runner, ["container", "inspect", "dim-control-plane-native-git-1", "dim-control-plane-ordinary-ci-1"]);
  const values = JSON.parse(result.stdout);
  return Object.fromEntries(values.map((value) => [value.Name.slice(1), value.Id]));
}

async function assertReadinessEvents(runner, runtime, since, forbiddenValues) {
  const until = new Date().toISOString();
  for (const id of Object.values(runtime)) {
    const result = await docker(runner, [
      "events", "--since", since, "--until", until, "--filter", `container=${id}`,
      "--filter", "event=exec_create", "--format", "{{json .}}"
    ]);
    assertSecretsAbsent(result.stdout + result.stderr, forbiddenValues);
    const events = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(events.some((event) => event.Actor?.ID === id
      && event.Action === "exec_create: /usr/local/bin/dim-service ready"), true);
  }
}

async function assertNetworkMembers(runner) {
  const result = await docker(runner, ["network", "inspect", "dim-control-plane"]);
  const network = JSON.parse(result.stdout)[0];
  assert.deepEqual(Object.values(network.Containers).map(({ Name }) => Name).sort(), [
    "dim-control-plane-native-git-1", "dim-control-plane-ordinary-ci-1"
  ]);
}

async function localhostFailure(port) {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => reject(new Error(`isolated installer reached published port ${port}`)));
    socket.once("error", (error) => resolve(error.code));
    socket.once("timeout", () => { socket.destroy(); resolve("ETIMEDOUT"); });
  });
}

async function docker(runner, args) {
  const result = await runner.run({ args, timeoutMilliseconds: 30_000, maximumOutputBytes: 1024 * 1024 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result;
}

function assertSecretsAbsent(value, forbiddenValues) {
  for (const secret of forbiddenValues) assert.equal(value.includes(secret), false);
}

function byDestination(left, right) {
  return left.Destination.localeCompare(right.Destination);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[2] === "child") await runChild();
