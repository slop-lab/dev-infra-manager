import assert from "node:assert/strict";
import { chmod, chown, lstat, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { captureDenialEvidence, assertDenialEvidence } from "./control-plane-install-live-evidence.mjs";
import { runFacade, runFacadeCommand } from "./control-plane-install-live-support.mjs";

export async function runPreInstallDenials(context) {
  await runFacadeDenial(context, {
    name: "obsolete-install-cp", status: 2,
    args: ["install-cp"], error: /dim installer install control-plane --config FILE/
  });
  await withSymlink(context, "config-symlink", /non-symbolic-link/);
  await withMetadata(context, "config-wrong-owner", async () => chown(context.configPath, 65534, 65534), /owned by the DIM user/);
  await withMetadata(context, "config-wrong-mode", async () => chmod(context.configPath, 0o640), /mode 0600/);

  const configCases = [
    ["unknown-field", (value) => { value.unexpected = true; }, /exactly the documented keys/],
    ["schema-mismatch", (value) => { value.schemaVersion = 2; }, /schemaVersion must be 1/],
    ["mutable-image", (value) => { value.nativeGit.image = "registry.example/native-git:latest"; }, /pinned only by a complete sha256 digest/],
    ["duplicate-port", (value) => { value.ordinaryCi.publish.port = value.nativeGit.publish.port; }, /published ports must be distinct/],
    ["wildcard-port", (value) => { value.nativeGit.publish.host = "0.0.0.0"; }, /must not be a wildcard address/]
  ];
  for (const [name, mutate, error] of configCases) {
    await withJsonMutation(context, context.configPath, name, mutate, error);
  }
  await withJsonMutation(context, context.sources.nativeGit, "invalid-service-config", (value) => {
    value.schemaVersion = 1;
  }, /not an idle bundle schema-2 config/);
  await withJsonMutation(context, context.sources.ordinaryCi, "paired-credential-mismatch", (value) => {
    value.nativeGit.identity.password = Buffer.alloc(32, 41).toString("base64url");
  }, /paired credentials must match/);
  await withJsonMutation(context, context.sources.ordinaryCi, "duplicate-credential", (value) => {
    value.credentials.registrar.password = value.hosts[0].hostToken;
  }, /credential and token values must be distinct/);
  await withNetworkFixture(context, "foreign-labels", [
    "--label", `dev.dim.verification=${context.verificationId}`
  ], /preflight failed before resource mutation/);
  await withNetworkFixture(context, "partial-resources", [
    "--label", `dev.dim.verification=${context.verificationId}`,
    "--label", "org.dim.managed=true", "--label", "org.dim.bundle=control-plane",
    "--label", `org.dim.deployment=${context.deploymentId}`,
    "--label", "org.dim.resource=network",
    "--label", "com.docker.compose.project=dim-control-plane",
    "--label", "com.docker.compose.network=dim-control-plane"
  ], /preflight failed before resource mutation/);
  await withVolumeFixture(context, "preexisting-fixed-ordinary-volume", /preflight failed before resource mutation/);
}

export async function runOccupiedPortDenial(context) {
  await runFacadeDenial(context, { name: "occupied-port", status: 1, error: /preflight failed before resource mutation/ });
}

export async function runChangedDeploymentDenial(context) {
  await withJsonMutation(context, context.configPath, "changed-deployment-id", (value) => {
    value.deploymentId = `${context.deploymentId}-changed`;
  }, /changing the control-plane deployment ID in place is unsupported/);
}

export async function runFacadeDenial(context, input) {
  const before = await captureDenialEvidence(context);
  const result = input.args === undefined
    ? await runFacade(context.facadeInput)
    : await runFacadeCommand(context.facadeInput, input.args);
  assert.equal(result.exitCode, input.status, `${input.name} stderr: ${result.stderr}`);
  assert.match(result.stderr, input.error);
  for (const secret of context.facadeInput.forbiddenOutput) {
    assert.equal(result.stdout.includes(secret) || result.stderr.includes(secret), false);
  }
  const after = await captureDenialEvidence(context);
  assertDenialEvidence(input.name, result.exitCode, before, after);
}

async function withJsonMutation(context, path, name, mutate, error) {
  const original = await readFile(path);
  const metadata = await lstat(path);
  const value = JSON.parse(original.toString("utf8"));
  mutate(value);
  try {
    await writePrivate(path, Buffer.from(`${JSON.stringify(value)}\n`));
    await runFacadeDenial(context, { name, status: 1, error });
  } finally {
    await writePrivate(path, original);
    await chown(path, metadata.uid, metadata.gid);
  }
}

async function withMetadata(context, name, mutate, error) {
  const metadata = await lstat(context.configPath);
  try {
    await mutate();
    await runFacadeDenial(context, { name, status: 1, error });
  } finally {
    await chown(context.configPath, metadata.uid, metadata.gid);
    await chmod(context.configPath, metadata.mode & 0o777);
  }
}

async function withSymlink(context, name, error) {
  const target = `${context.configPath}.symlink-target`;
  const original = await readFile(context.configPath);
  await rename(context.configPath, target);
  await symlink(target, context.configPath);
  try {
    await runFacadeDenial(context, { name, status: 1, error });
  } finally {
    await rm(context.configPath);
    await rename(target, context.configPath);
    assert.deepEqual(await readFile(context.configPath), original);
  }
}

async function withNetworkFixture(context, name, labels, error) {
  const created = await docker(context, ["network", "create", ...labels, "dim-control-plane"]);
  const identity = created.stdout.trim();
  assert.match(identity, /^[0-9a-f]{64}$/);
  try {
    await runFacadeDenial(context, { name, status: 1, error });
  } finally {
    const current = await docker(context, [
      "network", "inspect", "dim-control-plane", "--format",
      "{{.Id}}|{{index .Labels \"dev.dim.verification\"}}"
    ]);
    assert.equal(current.stdout.trim(), `${identity}|${context.verificationId}`);
    await docker(context, ["network", "rm", identity]);
  }
}

async function withVolumeFixture(context, name, error) {
  await docker(context, [
    "volume", "create", "--label", `dev.dim.verification=${context.verificationId}`,
    "dim-control-plane-ordinary-ci-data"
  ]);
  try {
    await runFacadeDenial(context, { name, status: 1, error });
  } finally {
    const current = await docker(context, [
      "volume", "inspect", "dim-control-plane-ordinary-ci-data", "--format",
      "{{.Name}}|{{index .Labels \"dev.dim.verification\"}}"
    ]);
    assert.equal(current.stdout.trim(), `dim-control-plane-ordinary-ci-data|${context.verificationId}`);
    await docker(context, ["volume", "rm", "dim-control-plane-ordinary-ci-data"]);
  }
}

async function writePrivate(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function docker(context, args) {
  const result = await context.runner.run({ args, timeoutMilliseconds: 30_000, maximumOutputBytes: 64 * 1024 });
  assert.equal(result.exitCode, 0, `docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return result;
}
