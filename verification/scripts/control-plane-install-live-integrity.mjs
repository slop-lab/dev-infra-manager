import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureDenialEvidence, assertDenialEvidence } from "./control-plane-install-live-evidence.mjs";
import { runFacade } from "./control-plane-install-live-support.mjs";

export function nonexistentDigestReference(reference) {
  assert.match(reference, /@sha256:[0-9a-f]{64}$/);
  const [repository, digest] = reference.split("@sha256:");
  const nonexistent = digest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
  return `${repository}@sha256:${nonexistent}`;
}

export async function runWrongDigestDenial(context, knownReference) {
  const original = await readFile(context.configPath);
  const config = JSON.parse(original.toString("utf8"));
  const wrongReference = nonexistentDigestReference(knownReference);
  config.nativeGit.image = wrongReference;
  try {
    await writeFile(context.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    await chmod(context.configPath, 0o600);
    const before = await captureDenialEvidence(context);
    const result = await runFacade(context.facadeInput);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /control-plane preflight failed before resource mutation/);
    assert.match(result.stderr, /preflight stage: native-git image pull/);
    assert.match(result.stderr, /failed pull may have left a partial cache entry/);
    const after = await captureDenialEvidence(context);
    assertDenialEvidence("image-digest-mismatch", result.exitCode, before, after);
    console.log(`integrity-denial case=image-digest-mismatch status=${result.exitCode} reference=${wrongReference} facade-stage=native-git-image-pull daemon-detail=suppressed cache=partial-may-remain`);
  } finally {
    await writeFile(context.configPath, original, { mode: 0o600 });
    await chmod(context.configPath, 0o600);
  }
}

export async function runMissingComposeHarness(input) {
  const beforeVersion = await input.runner.run({
    args: ["compose", "version", "--short"], timeoutMilliseconds: 5000, maximumOutputBytes: 4096
  });
  assert.equal(beforeVersion.exitCode, 0, beforeVersion.stderr);
  const result = await input.runner.run({
    args: [
      "container", "run", "--rm", "--name", input.containerName,
      "--label", `org.dim.verification=${input.verificationId}`, "--network", "none",
      "--mount", `type=bind,src=${input.daemonSocketSource},dst=/run/docker.sock`,
      "--mount", `type=volume,src=${input.harnessVolume},dst=${input.root}`,
      "--env", `HARNESS_ROOT=${input.root}`, "--env", `DEPLOYMENT_ID=${input.deploymentId}`,
      "--env", `NO_COMPOSE_CONTAINER_NAME=${input.containerName}`,
      input.image, "node", join(input.root, "control-plane-install-live-integrity.mjs"), "missing-compose"
    ],
    timeoutMilliseconds: 30_000,
    maximumOutputBytes: 1024 * 1024
  });
  assert.equal(result.exitCode, 0, result.stderr);
  process.stdout.write(result.stdout);
  const afterVersion = await input.runner.run({
    args: ["compose", "version", "--short"], timeoutMilliseconds: 5000, maximumOutputBytes: 4096
  });
  assert.deepEqual(afterVersion, beforeVersion);
  const residue = await input.runner.run({
    args: ["container", "inspect", input.containerName], timeoutMilliseconds: 5000, maximumOutputBytes: 4096
  });
  assert.notEqual(residue.exitCode, 0);
}

export async function inspectEffectiveCompose(input) {
  const composePath = join(input.stateRoot, "compose.yml");
  const composeBytes = await readFile(composePath);
  const result = await input.runner.run({
    args: ["compose", "--project-name", "dim-control-plane", "--file", composePath, "config", "--format", "json"],
    timeoutMilliseconds: 30_000,
    maximumOutputBytes: 1024 * 1024
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const model = JSON.parse(result.stdout);
  assertEffectiveComposeModel({ ...input, model });
  console.log(`effective-compose services=native-git,ordinary-ci network=dim-control-plane volumes=dim-control-plane-native-git-data,dim-control-plane-ordinary-ci-data composeSha256=${sha256(composeBytes)} modelSha256=${sha256(Buffer.from(result.stdout))} secretLeaks=0`);
}

export function assertEffectiveComposeModel(input) {
  const { model, record } = input;
  assert.equal(model.name, "dim-control-plane");
  assert.deepEqual(Object.keys(model.services).sort(), ["native-git", "ordinary-ci"]);
  assert.deepEqual(Object.keys(model.networks), ["dim-control-plane"]);
  assert.deepEqual(Object.keys(model.volumes).sort(), [
    "dim-control-plane-native-git-data", "dim-control-plane-ordinary-ci-data"
  ]);
  assert.deepEqual(model.networks["dim-control-plane"], {
    name: "dim-control-plane", driver: "bridge", ipam: {}, labels: labels(record.deploymentId, "network")
  });
  assert.deepEqual(model.volumes["dim-control-plane-native-git-data"], {
    name: "dim-control-plane-native-git-data", labels: labels(record.deploymentId, "volume", "native-git")
  });
  assert.deepEqual(model.volumes["dim-control-plane-ordinary-ci-data"], {
    name: "dim-control-plane-ordinary-ci-data", labels: labels(record.deploymentId, "volume", "ordinary-ci")
  });
  assertService(input, "native-git", "10001:10001", record.nativeGitImage, record.nativeGitPublish,
    "/var/lib/dim-native-git", "dim-control-plane-native-git-data");
  assertService(input, "ordinary-ci", "10002:10002", record.ordinaryCiImage, record.ordinaryCiPublish,
    "/var/lib/dim-ordinary-ci", "dim-control-plane-ordinary-ci-data");
  assert.equal(model.secrets, undefined);
  assert.equal(model.configs, undefined);
  const rendered = JSON.stringify(model);
  for (const value of [...input.operatorPaths, ...input.forbiddenValues]) {
    assert.equal(rendered.includes(value), false, "effective Compose model leaked operator input or secret bytes");
  }
  for (const forbidden of ["docker.sock", "containerd.sock", "controller", "workspace", "/dev/kvm"]) {
    assert.equal(rendered.includes(forbidden), false, `effective Compose model contains forbidden ${forbidden}`);
  }
}

function assertService(input, name, user, image, publish, stateTarget, stateVolume) {
  const service = input.model.services[name];
  assert.equal(service.image, image);
  assert.deepEqual(service.command, ["serve", "/run/secrets/service.json", input.record.generationId]);
  assert.equal(service.user, user);
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  assert.deepEqual(service.tmpfs, ["/tmp:rw,nosuid,nodev,noexec,mode=1777"]);
  assert.deepEqual(service.ports, [{
    mode: "ingress", target: 8080, published: String(publish.port), protocol: "tcp", host_ip: publish.host
  }]);
  assert.deepEqual(service.networks, { "dim-control-plane": null });
  assert.deepEqual(service.labels, labels(input.record.deploymentId, "service", name));
  assert.equal(service.environment, undefined);
  assert.equal(service.privileged, undefined);
  assert.equal(service.devices, undefined);
  assert.equal(service.network_mode, undefined);
  assert.equal(service.pid, undefined);
  assert.equal(service.ipc, undefined);
  assert.equal(service.userns_mode, undefined);
  assert.equal(service.volumes.length, 4);
  const generationRoot = join(input.stateRoot, "generations", input.record.generationId);
  assert.deepEqual(service.volumes.map(({ type, source, target, read_only: readOnly }) => ({ type, source, target, readOnly })), [
    { type: "bind", source: join(generationRoot, `${name}.json`), target: "/run/secrets/service.json", readOnly: true },
    { type: "bind", source: join(generationRoot, `${name}-readiness.token`), target: "/run/secrets/readiness.token", readOnly: true },
    { type: "bind", source: join(generationRoot, `${name}-activation.token`), target: "/run/secrets/activation.token", readOnly: true },
    { type: "volume", source: stateVolume, target: stateTarget, readOnly: undefined }
  ]);
}

function labels(deploymentId, resource, service) {
  return {
    "org.dim.managed": "true", "org.dim.bundle": "control-plane",
    "org.dim.deployment": deploymentId, "org.dim.resource": resource,
    ...(service === undefined ? {} : { "org.dim.service": service })
  };
}

async function runMissingComposeDenial() {
  const root = requiredEnvironment("HARNESS_ROOT");
  const stateRoot = join(root, "state-home", "dim", "control-plane");
  const operatorRoot = join(root, "operator");
  const { ProcessControlPlaneDockerRunner } = await import(
    pathToFileURL(join(root, "installer", "controlPlaneDocker.js")).href
  );
  const runner = new ProcessControlPlaneDockerRunner();
  await assertNoComposeHarness(runner, requiredEnvironment("NO_COMPOSE_CONTAINER_NAME"), root);
  const context = {
    configPath: join(operatorRoot, "install.json"), stateRoot, runner,
    deploymentId: requiredEnvironment("DEPLOYMENT_ID"),
    sources: {
      nativeGit: join(operatorRoot, "native-git.json"),
      nativeReadiness: join(operatorRoot, "native-readiness.token"),
      ordinaryCi: join(operatorRoot, "ordinary-ci.json"),
      ordinaryReadiness: join(operatorRoot, "ordinary-readiness.token")
    },
    facadeInput: {
      executable: join(root, "installer", "dim"), configPath: join(operatorRoot, "install.json"),
      stateRoot, cwd: operatorRoot,
      environment: { ...process.env, HOME: operatorRoot, XDG_STATE_HOME: join(root, "state-home") },
      forbiddenOutput: []
    }
  };
  const before = await captureDenialEvidence(context);
  const result = await runFacade(context.facadeInput);
  assert.equal(result.exitCode, 1, result.stderr);
  assert.match(result.stderr, /control-plane preflight failed before resource mutation/);
  const after = await captureDenialEvidence(context);
  assertDenialEvidence("compose-v2-absence", result.exitCode, before, after);
  console.log(`integrity-denial case=compose-v2-absence status=${result.exitCode} compose-probe=unavailable facade-rejection=pre-mutation cli=/usr/local/bin/docker mounts=config-volume,socket host-cli=unchanged`);
}

async function assertNoComposeHarness(runner, name, root) {
  const compose = await runner.run({ args: ["compose", "version", "--short"], timeoutMilliseconds: 5000, maximumOutputBytes: 4096 });
  assert.notEqual(compose.exitCode, 0);
  const metadata = await lstat("/usr/local/bin/docker");
  assert.equal(metadata.uid, 0);
  assert.equal(metadata.mode & 0o022, 0);
  const inspected = await runner.run({ args: ["container", "inspect", name], timeoutMilliseconds: 5000, maximumOutputBytes: 64 * 1024 });
  assert.equal(inspected.exitCode, 0, inspected.stderr);
  const mounts = JSON.parse(inspected.stdout)[0].Mounts.map(({ Type, Destination }) => ({ Type, Destination }));
  assert.deepEqual(mounts.sort((left, right) => left.Destination.localeCompare(right.Destination)), [
    { Type: "bind", Destination: "/run/docker.sock" }, { Type: "volume", Destination: root }
  ].sort((left, right) => left.Destination.localeCompare(right.Destination)));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.notEqual(value, undefined, `${name} is required`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[2] === "missing-compose") await runMissingComposeDenial();
