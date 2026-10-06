import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFacade } from "./control-plane-install-live-support.mjs";

const nativeVolume = "dim-control-plane-native-git-data";
const ordinaryVolume = "dim-control-plane-ordinary-ci-data";
const services = ["native-git", "ordinary-ci"];
const labelFormat = "{{.Id}}\n{{.Driver}}\n{{json .Labels}}";
const volumeFormat = "{{.Name}}\n{{.Driver}}\n{{json .Labels}}";
const containerFormat = "{{.Id}}\n{{.Name}}\n{{json .Config.Labels}}";

export async function runMissingEstablishedVolume(context) {
  assert.equal(context.deploymentId, `live-${context.verificationId}`);
  const stateBefore = await stateEvidence(context.stateRoot);
  const networkBefore = await networkEvidence(context.runner);
  const nativeBefore = await ownedVolume(nativeVolume, "native-git", context);
  const ordinaryBefore = await ownedVolume(ordinaryVolume, "ordinary-ci", context);
  const savedContainers = Object.fromEntries(await Promise.all(services.map(async (service) => {
    const value = await inspect("container", `dim-control-plane-${service}-1`, context.runner);
    assertOwned(value.Config.Labels, "service", service, context.deploymentId);
    assert.equal(value.Name, `/dim-control-plane-${service}-1`);
    assert.match(value.Id, /^[0-9a-f]{64}$/);
    return [service, value.Id];
  })));
  assert.deepEqual(await networkEvidence(context.runner), networkBefore);

  for (const service of services) {
    const current = await inspect("container", `dim-control-plane-${service}-1`, context.runner);
    assert.equal(current.Id, savedContainers[service], `${service} container identity changed before removal`);
    assertOwned(current.Config.Labels, "service", service, context.deploymentId);
    const removed = await docker(context.runner, ["container", "rm", "--force", savedContainers[service]]);
    assert.equal(removed.stdout, `${savedContainers[service]}\n`);
  }
  await assertUnused(nativeVolume, context.runner);
  await assertUnused(ordinaryVolume, context.runner);

  const nativeContentBefore = await volumeDigest(nativeVolume, context);
  const ordinaryContentBefore = await volumeDigest(ordinaryVolume, context);
  await assertUnused(nativeVolume, context.runner);
  const nativeRemovalCandidate = await ownedVolume(nativeVolume, "native-git", context);
  assert.deepEqual(nativeRemovalCandidate, nativeBefore);
  const removed = await docker(context.runner, ["volume", "rm", nativeVolume]);
  assert.equal(removed.stdout, `${nativeVolume}\n`);
  console.log(`missing-volume-removal ${JSON.stringify({
    volume: nativeVolume,
    verificationId: context.verificationId,
    deploymentId: context.deploymentId,
    labels: nativeBefore.Labels,
    users: [],
    savedContainers,
    volumeDigest: nativeContentBefore
  })}`);

  const commandLog = join(context.facadeInput.cwd, "missing-volume-docker-commands.ndjson");
  const result = await tracedFacade(context.facadeInput, commandLog);
  const commands = (await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /established control-plane data volume 'dim-control-plane-native-git-data' is missing; refusing to recreate it because this is a fatal data-loss condition/);
  assertRefusalCommands(commands);

  const stateAfter = await stateEvidence(context.stateRoot);
  const networkAfter = await networkEvidence(context.runner);
  const ordinaryAfter = await ownedVolume(ordinaryVolume, "ordinary-ci", context);
  const ordinaryContentAfter = await volumeDigest(ordinaryVolume, context);
  await assertUnused(ordinaryVolume, context.runner);
  assert.deepEqual(stateAfter.installBytes, stateBefore.installBytes);
  assert.deepEqual(stateAfter.composeBytes, stateBefore.composeBytes);
  assert.deepEqual(networkAfter, networkBefore);
  assert.deepEqual(ordinaryAfter, ordinaryBefore);
  assert.equal(ordinaryContentAfter, ordinaryContentBefore);
  await assertMissing("volume", nativeVolume, context.runner);
  for (const service of services) await assertMissing("container", `dim-control-plane-${service}-1`, context.runner);
  console.log(`missing-volume-refusal ${JSON.stringify({
    exitCode: result.exitCode,
    stderr: result.stderr.trim(),
    commands,
    stateBefore: stateSummary(stateBefore),
    stateAfter: stateSummary(stateAfter),
    otherVolumeBefore: ordinaryBefore,
    otherVolumeAfter: ordinaryAfter,
    otherVolumeDigestBefore: ordinaryContentBefore,
    otherVolumeDigestAfter: ordinaryContentAfter,
    removedVolume: "absent",
    serviceContainers: "absent"
  })}`);
}

async function ownedVolume(name, service, context) {
  const value = await inspect("volume", name, context.runner);
  assert.equal(value.Name, name);
  assert.equal(value.Driver, "local");
  assertOwned(value.Labels, "volume", service, context.deploymentId);
  return {
    Name: value.Name,
    Driver: value.Driver,
    Scope: value.Scope,
    CreatedAt: value.CreatedAt,
    Mountpoint: value.Mountpoint,
    Labels: value.Labels,
    Options: value.Options
  };
}

function assertOwned(labels, resource, service, deploymentId) {
  const expected = {
    "org.dim.managed": "true",
    "org.dim.bundle": "control-plane",
    "org.dim.deployment": deploymentId,
    "org.dim.resource": resource,
    "org.dim.service": service
  };
  assert.deepEqual(Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith("org.dim."))), expected);
  assert.equal(labels["com.docker.compose.project"], "dim-control-plane");
  if (resource === "volume") assert.equal(labels["com.docker.compose.volume"], `dim-control-plane-${service}-data`);
  else {
    assert.equal(labels["com.docker.compose.service"], service);
    assert.equal(labels["com.docker.compose.container-number"], "1");
    assert.equal(labels["com.docker.compose.oneoff"], "False");
  }
}

async function volumeDigest(name, context) {
  const source = `
    import {createHash} from "node:crypto";
    import {lstatSync,readdirSync,readFileSync} from "node:fs";
    import {join,relative} from "node:path";
    const hash=createHash("sha256");
    const visit=(path)=>{for(const entry of readdirSync(path).sort()){const child=join(path,entry);const stat=lstatSync(child,{bigint:true});hash.update(relative("/data",child)).update(String(stat.mode)).update(String(stat.uid)).update(String(stat.gid)).update(String(stat.size)).update(String(stat.mtimeNs)).update(String(stat.ctimeNs));if(stat.isDirectory())visit(child);else if(stat.isFile())hash.update(readFileSync(child));else process.exit(91);}};
    visit("/data");process.stdout.write(hash.digest("hex")+"\\n");
  `;
  const result = await docker(context.runner, [
    "container", "run", "--rm", "--name", context.probeName,
    "--label", `org.dim.verification=${context.verificationId}`,
    "--network", "none", "--user", "0:0",
    "--mount", `type=volume,src=${name},dst=/data,readonly`,
    "--entrypoint", "node", context.probeImage, "--input-type=module", "--eval", source
  ]);
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/);
  return result.stdout.trim();
}

async function stateEvidence(stateRoot) {
  const install = await readFile(join(stateRoot, "install.json"));
  const compose = await readFile(join(stateRoot, "compose.yml"));
  return { installBytes: install, composeBytes: compose, installSha256: digest(install), composeSha256: digest(compose) };
}

function stateSummary(state) {
  return { installSha256: state.installSha256, composeSha256: state.composeSha256 };
}

async function tracedFacade(facadeInput, commandLog) {
  const executable = "/usr/local/bin/docker";
  const delegate = "/usr/local/bin/docker.dim-live-real";
  const original = await fileIdentity(executable);
  await assertMissingPath(delegate);
  await rename(executable, delegate);
  try {
    const wrapper = `#!/usr/bin/env node\nimport {appendFileSync} from "node:fs";import {spawnSync} from "node:child_process";appendFileSync(${JSON.stringify(commandLog)},JSON.stringify(process.argv.slice(2))+"\\n",{mode:0o600});const result=spawnSync(${JSON.stringify(delegate)},process.argv.slice(2),{env:process.env,stdio:"inherit"});if(result.error)throw result.error;process.exit(result.status??1);\n`;
    await writeFile(executable, wrapper, { mode: 0o755, flag: "wx" });
    await chmod(executable, 0o755);
    return await runFacade(facadeInput);
  } finally {
    await rename(delegate, executable);
  }
  assert.deepEqual(await fileIdentity(executable), original);
  await assertMissingPath(delegate);
}

async function fileIdentity(path) {
  const value = await lstat(path, { bigint: true });
  assert.equal(value.isFile(), true);
  return { dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, gid: value.gid, size: value.size };
}

async function networkEvidence(runner) {
  const value = await inspect("network", "dim-control-plane", runner);
  return {
    Name: value.Name,
    Id: value.Id,
    Created: value.Created,
    Scope: value.Scope,
    Driver: value.Driver,
    EnableIPv4: value.EnableIPv4,
    EnableIPv6: value.EnableIPv6,
    IPAM: value.IPAM,
    Internal: value.Internal,
    Attachable: value.Attachable,
    Ingress: value.Ingress,
    ConfigOnly: value.ConfigOnly,
    Options: value.Options,
    Labels: value.Labels
  };
}

async function inspect(kind, name, runner) {
  const result = await docker(runner, [kind, "inspect", name]);
  const values = JSON.parse(result.stdout);
  assert.equal(values.length, 1);
  return values[0];
}

async function assertUnused(name, runner) {
  const result = await docker(runner, ["container", "ls", "--all", "--no-trunc", "--filter", `volume=${name}`, "--format", "{{.ID}}"]);
  assert.equal(result.stdout, "", `${name} still has attached containers`);
}

async function assertMissing(kind, name, runner) {
  const result = await runner.run({ args: [kind, "inspect", name], timeoutMilliseconds: 10_000, maximumOutputBytes: 4096 });
  assert.notEqual(result.exitCode, 0, `${kind} ${name} unexpectedly exists`);
}

async function assertMissingPath(path) {
  await assert.rejects(lstat(path), (error) => error instanceof Error && "code" in error && error.code === "ENOENT");
}

async function docker(runner, args) {
  const result = await runner.run({ args, timeoutMilliseconds: 300_000, maximumOutputBytes: 1024 * 1024 });
  assert.equal(result.exitCode, 0, `docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return result;
}

function expectedRefusalCommands() {
  return [
    ["compose", "version", "--short"],
    ["network", "inspect", "dim-control-plane", "--format", labelFormat],
    ["volume", "inspect", nativeVolume, "--format", volumeFormat],
    ["volume", "inspect", ordinaryVolume, "--format", volumeFormat],
    ["container", "inspect", "dim-control-plane-native-git-1", "--format", containerFormat],
    ["container", "inspect", "dim-control-plane-ordinary-ci-1", "--format", containerFormat],
    ["network", "ls", "--no-trunc", "--filter", "label=com.docker.compose.project=dim-control-plane", "--format", "{{.ID}}"],
    ["volume", "ls", "--filter", "label=com.docker.compose.project=dim-control-plane", "--format", "{{.Name}}"],
    ["container", "ls", "--all", "--no-trunc", "--filter", "label=com.docker.compose.project=dim-control-plane", "--format", "{{.ID}}"]
  ];
}

function assertRefusalCommands(commands) {
  const expected = expectedRefusalCommands();
  assert.deepEqual(commands.slice(0, 6), expected.slice(0, 6));
  const canonical = (entries) => entries.map((entry) => JSON.stringify(entry)).sort();
  assert.deepEqual(canonical(commands.slice(6)), canonical(expected.slice(6)));
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
