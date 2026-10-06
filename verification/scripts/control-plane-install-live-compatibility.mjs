import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { captureDenialEvidence, assertDenialEvidence } from "./control-plane-install-live-evidence.mjs";
import { installWithFacade, runFacade } from "./control-plane-install-live-support.mjs";

export const candidateCompatibilityDenials = [
  { profile: "compatibility-missing-field", outcome: "response-not-exact" },
  { profile: "compatibility-malformed-json", outcome: "malformed-json" },
  { profile: "candidate-write-unreadable-by-prior", outcome: "asymmetric-candidate-write" },
  { profile: "non-overlapping-formats", outcome: "non-overlap" },
  { profile: "candidate-state-format-mismatch", outcome: "candidate-state-disagreement" }
];

export const priorCompatibilityDenials = [
  { profile: "prior-write-unreadable-by-candidate", outcome: "one-way-prior-write" },
  { profile: "prior-state-format-mismatch", outcome: "prior-state-disagreement" }
];

const services = ["nativeGit", "ordinaryCi"];
const digestPattern = /^127\.0\.0\.1:[0-9]+\/[a-z0-9/_-]+@sha256:[0-9a-f]{64}$/;

export function parseCompatibilityVariantManifest(contents) {
  const manifest = { nativeGit: {}, ordinaryCi: {} };
  for (const line of contents.trim().split("\n")) {
    const [service, profile, image, extra] = line.split("\t");
    assert.equal(extra, undefined, `variant manifest line has extra fields: ${line}`);
    assert.equal(services.includes(service), true, `variant manifest service is invalid: ${service}`);
    assert.equal(typeof profile, "string");
    assert.equal(profile.length > 0, true);
    assert.match(image ?? "", digestPattern);
    assert.equal(Object.hasOwn(manifest[service], profile), false, `duplicate variant ${service}/${profile}`);
    manifest[service][profile] = image;
  }
  const profiles = [...candidateCompatibilityDenials, ...priorCompatibilityDenials].map(({ profile }) => profile);
  for (const service of services) {
    assert.deepEqual(Object.keys(manifest[service]).sort(), [...profiles].sort());
  }
  return manifest;
}

export async function runLiveCandidateCompatibilityDenials(input) {
  for (const service of services) {
    for (const denial of candidateCompatibilityDenials) {
      const selected = { ...input.candidateImages, [service]: input.variants[service][denial.profile] };
      await input.writeConfig(selected);
      await runStableDenial(input, `live-candidate-${service}-${denial.profile}`, denial.outcome, selected);
    }
  }
  await input.writeConfig(input.priorImages);
}

export async function runLivePriorCompatibilityDenials(input) {
  for (const service of services) {
    for (const denial of priorCompatibilityDenials) {
      const selected = { ...input.priorImages, [service]: input.variants[service][denial.profile] };
      await input.writeConfig(selected);
      const installed = await installWithFacade(input.denialContext.facadeInput);
      await input.assertDeployment(installed, selected);
      await input.assertSentinels(true);
      await input.writeConfig(input.candidateImages);
      await runStableDenial(input, `live-prior-${service}-${denial.profile}`, denial.outcome, input.candidateImages);
      await removeTestOwnedPrior(input);
    }
  }
  await input.writeConfig(input.priorImages);
}

async function runStableDenial(input, name, outcome, selectedImages) {
  const [before, runtime, volumes] = await Promise.all([
    captureDenialEvidence(input.denialContext), input.captureRuntime(), input.captureVolumes()
  ]);
  const calls = [];
  const recordingRunner = {
    run: async (command) => {
      calls.push(command.args);
      return await input.denialContext.runner.run(command);
    }
  };
  await assert.rejects(input.installApi(recordingRunner));
  assert.equal(calls.some((args) => args.includes("--force-recreate")), false, `${name} issued a replacement command`);
  const probeOrder = calls.filter((args) => args[0] === "run"
    && (args.includes("compatibility") || args.includes("check-state")))
    .map((args) => describeProbe(args, selectedImages));
  assert.equal(probeOrder.length > 0, true);
  const result = await runFacade(input.denialContext.facadeInput);
  assert.notEqual(result.exitCode, 0, `${name} unexpectedly succeeded`);
  assert.equal(result.stderr, "dim: control-plane preflight failed before resource mutation\n");
  assert.equal(result.stdout, "");
  const [after, runtimeAfter, volumesAfter] = await Promise.all([
    captureDenialEvidence(input.denialContext), input.captureRuntime(), input.captureVolumes()
  ]);
  assertDenialEvidence(name, result.exitCode, before, after);
  assert.deepEqual(runtimeAfter, runtime, `${name} replaced a service`);
  assert.deepEqual(volumesAfter, volumes, `${name} changed a volume identity`);
  await input.assertSentinels(false);
  console.log(`compatibility-denial case=${name} facade-status=${result.exitCode} outcome=${outcome} probe-order=${probeOrder.join(",")} replacement-commands=0 state=identical resources=identical`);
}

function describeProbe(args, selectedImages) {
  const service = args.includes("10001:10001") ? "nativeGit" : "ordinaryCi";
  const entrypoint = args.indexOf("--entrypoint");
  assert.notEqual(entrypoint, -1);
  const image = args[entrypoint + 2];
  const role = image === selectedImages[service] ? "candidate" : "prior";
  const operation = args.includes("compatibility") ? "compatibility" : "state";
  return `${service}:${role}:${operation}`;
}

async function removeTestOwnedPrior(input) {
  const resources = [
    ["container", "dim-control-plane-native-git-1", "native-git"],
    ["container", "dim-control-plane-ordinary-ci-1", "ordinary-ci"],
    ["network", "dim-control-plane", ""],
    ["volume", "dim-control-plane-native-git-data", "native-git"],
    ["volume", "dim-control-plane-ordinary-ci-data", "ordinary-ci"]
  ];
  for (const [kind, name, service] of resources) {
    const value = JSON.parse((await docker(input, [kind, "inspect", name])).stdout)[0];
    const labels = kind === "container" ? value.Config.Labels : value.Labels;
    assert.equal(labels["org.dim.managed"], "true");
    assert.equal(labels["org.dim.bundle"], "control-plane");
    assert.equal(labels["org.dim.deployment"], input.deploymentId);
    assert.equal(labels["org.dim.resource"], kind === "container" ? "service" : kind);
    if (service !== "") assert.equal(labels["org.dim.service"], service);
  }
  const runtime = await input.captureRuntime();
  await docker(input, ["container", "rm", "--force", runtime.nativeGit.id, runtime.ordinaryCi.id]);
  await docker(input, ["network", "rm", "dim-control-plane"]);
  await docker(input, ["volume", "rm", "dim-control-plane-native-git-data", "dim-control-plane-ordinary-ci-data"]);
  await rm(input.denialContext.stateRoot, { recursive: true });
  console.log("compatibility-prior-phase-cleanup owned-resources=removed state=removed unknown-resources=untouched");
}

async function docker(input, args) {
  const result = await input.denialContext.runner.run({ args, timeoutMilliseconds: 30_000, maximumOutputBytes: 256 * 1024 });
  assert.equal(result.exitCode, 0, `docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return result;
}
