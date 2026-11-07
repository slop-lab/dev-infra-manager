import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { readExampleArtifacts } from "../../../../scripts/examples/bundle.ts";
import { realSshFixture } from "../../../support/real-ssh.ts";
import { runCommand } from "../../web-lifecycle/process.ts";
import { fixtureModel } from "./provider.ts";
import { requirePracticalReport } from "./requiredReport.ts";
import { fixtureArtifactIdentity } from "./artifacts.ts";
import { cleanupIncusForwarding } from "./fixtureNetwork.ts";

const repository = resolve(import.meta.dirname, "../../../.."), facade = process.env.DIM_EXAMPLE_DIM_BIN, bundle = process.env.DIM_EXAMPLE_PACKAGE_BUNDLE,
  data = process.env.DIM_DATA_HOME, prefix = process.env.DIM_INSTALL_PREFIX, setup = process.env.DIM_EXAMPLE_REMOTE_SETUP, imageTag = process.env.DIM_EXAMPLE_WORKSPACE_IMAGE;
if (!facade || !bundle || !data || !prefix || !setup || !imageTag || process.env.DIM_PRACTICAL_CI_REQUIRED !== "1") throw new Error("required practical CI must run inside the provisioned installed example fixture");
const root = join(data, "practical-ci"); await mkdir(root, { mode: 0o700 });
const sourceSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
const sourceTree = (await runCommand("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })).stdout.trim();
const image = (await runCommand("docker", ["image", "inspect", imageTag, "--format", "{{.Id}}"])).stdout.trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("practical CI image is not immutable");
const prepared: unknown = JSON.parse(await readFile("/home/dim/dim/practical-host/image.json", "utf8"));
if (!prepared || typeof prepared !== "object" || !("sourceSha" in prepared) || prepared.sourceSha !== sourceSha || !("imageFingerprint" in prepared)
  || typeof prepared.imageFingerprint !== "string" || !("hostMachineId" in prepared) || prepared.hostMachineId !== (await readFile("/etc/machine-id", "utf8")).trim()
  || !("imageType" in prepared) || prepared.imageType !== "virtual-machine" || !("kvmProbe" in prepared) || prepared.kvmProbe !== "KVM_CREATE_VM") throw new Error("practical CI lacks exact real Incus/KVM preparation");
const addresses = await lookup("probe.ci.localhost", { all: true });
if (!addresses.some(({ address }) => address === "127.0.0.1")) throw new Error("Ubuntu fixture must resolve its private ci.localhost wildcard");
const artifacts = await readExampleArtifacts(bundle), version = artifacts.find(({ name }) => name === "@slop-lab/dim-cli")?.version;
if (!version) throw new Error("practical artifact version is missing");
await runCommand(facade, ["installer", "install", "cli", "--local-packages", bundle, "--local-bin"]);
const dim = join(prefix, "bin/dim"), expectedPublic = join(data, "cli/runtime/current/dim");
if (await realpath(dim) !== await realpath(expectedPublic)) throw new Error("practical SSH must use the normal installed public core CLI, not the installer facade");
const env: NodeJS.ProcessEnv = { ...process.env, DIM_BIN: dim, DIM_WORKSPACE_IMAGE: image };
const command = (args: readonly string[]) => runCommand(dim, ["--host", "local", ...args], { env });
await command(["vm", "configure", "/home/dim/dim/practical-host/host.json"]);
const directory = join(setup, "practical"), connection = join(root, "ingress.json");
await writeFile(connection, JSON.stringify({ schemaVersion: 1, endpoint: "http://127.0.0.1:18444", hostId: "practical-host", token: (await readFile(join(directory, "ingress.key"), "utf8")).trim(), domain: "ci.localhost" }), { mode: 0o600, flag: "wx" });
await command(["external-url", "ingress", "add", "control-plane", "--name", "practical", "--description", "Test-owned shared ingress over pinned inter-VM SSH", "--scheme", "http",
  "--connection-file", connection, "--listen-host", "127.0.0.1", "--listen-port", "18445", "--public-port", "18443"]);
const gateway = join(root, "gateway");
await command(["llm", "prepare", gateway, "--control-plane", "http://127.0.0.1:18318", "--issuer", "practical-host", "--issuer-key-file", join(directory, "issuer.key"), "--endpoint", "http://127.0.0.1:18319", "--listen-host", "127.0.0.1", "--port", "18319"]);
const gatewayLog = await (await import("node:fs/promises")).open(join(root, "gateway.log"), "wx", 0o600);
const server = spawn(dim, ["--host", "local", "llm", "serve", join(gateway, "gateway.json")], { env, stdio: ["ignore", gatewayLog.fd, gatewayLog.fd] });
let ssh: Awaited<ReturnType<typeof realSshFixture>> | undefined;
let forwardingCleaned = false;
const cleanupForwarding = async () => {
  const forwarding: unknown = JSON.parse(await readFile("/home/dim/dim/practical-host/forwarding.json", "utf8"));
  await cleanupIncusForwarding(forwarding, { sourceSha, machine: (await readFile("/etc/machine-id", "utf8")).trim() },
    (file, args) => runCommand(file, args, { acceptFailure: true, timeoutMs: 30_000 }));
  forwardingCleaned = true;
};
try {
  const remote: Record<string, string> = { PATH: `${join(prefix, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, DIM_WORKSPACE_IMAGE: image };
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "DIM_CONFIG_PATH", "DIM_DATA_HOME", "DIM_STATE_ROOT", "DIM_MANAGED_STATE_ROOT", "DIM_INSTALL_PREFIX"]) {
    const value = process.env[name]; if (value !== undefined) remote[name] = value;
  }
  ssh = await realSshFixture(root, remote); env.PATH = `${ssh.bin}:${env.PATH ?? ""}`;
  await command(["host", "add", "practical-ssh", "--ssh", ssh.target]);
  const source = join(root, "source"); await mkdir(source);
  await runCommand("git", ["init", "--initial-branch=main", source]); await writeFile(join(source, "README.md"), `Practical deterministic CI seed for ${sourceSha}\n`);
  await runCommand("git", ["-C", source, "add", "."]); await runCommand("git", ["-C", source, "-c", "user.name=Practical CI", "-c", "user.email=ci@example.invalid", "commit", "-m", "reviewed runtime seed"]);
  const seedSha = (await runCommand("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const key = join(root, "guest-key"); await runCommand("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
  const config = join(root, "hosts.json"), beforeBundle = "/home/dim/dim/practical-before-packages", beforeFacade = "/home/dim/dim/practical-before-facade/package/dim";
  await writeFile(config, JSON.stringify({ schemaVersion: 1, installedSourceSha: sourceSha, hosts: ["local", "practical-ssh"].map((name) => ({ name, workspace: `dim-smoke-ci-${name}`, source, workspaceSourceSha: seedSha,
    expectedHostVersion: version, image, requiredPlugins: ["agent-tools", "host-llm-router", "external-urls", "vm"], ingress: "practical", sshPublicKey: publicKey, llm: {
      configFile: join(gateway, "gateway.json"), project: "practical-ci", route: "ci", provider: "dim-chat", model: fixtureModel, operatorConnectionFile: join(directory, "reader.json") }, vm: { image: prepared.imageFingerprint } })),
    isolatedUpdate: { beforeFacade, beforeBundle, afterFacade: facade, afterBundle: bundle, image } }), { mode: 0o600, flag: "wx" });
  const output = await runCommand(process.execPath, ["--import", join(repository, "tests/node_modules/tsx/dist/loader.mjs"), join(repository, "scripts/checks/selected-host-usability-smoke.ts"),
    "--config", config, "--host", "local", "--host", "practical-ssh", "--json"], { env, cwd: repository, timeoutMs: 60 * 60_000 });
  const report = requirePracticalReport(JSON.parse(output.stdout), sourceSha, image);
  const after = await fixtureArtifactIdentity(bundle, repository), before = await fixtureArtifactIdentity(beforeBundle, repository);
  if (after.sourceSha !== sourceSha || after.sourceTree !== sourceTree || before.closureSha256 === after.closureSha256) throw new Error("practical fixture artifacts do not bind the exact distinct reviewed sources");
  const target = process.env.DIM_PRACTICAL_CI_RECEIPT;
  if (!target?.startsWith("/")) throw new Error("required practical receipt output is missing");
  await cleanupForwarding();
  await writeFile(target, JSON.stringify({ schemaVersion: 1, status: "PASS", sourceSha, sourceTree, artifactManifestSha256: after.manifestSha256, artifacts: { before, after }, image, incus: prepared,
    providerFixture: "TEST-ONLY deterministic protocol/tool acceptance; provider/account qualification NOT ASSESSED", publicEntry: { link: dim, target: expectedPublic }, forwardingCleanup: "exact-owned-rules-removed", report }), { mode: 0o600, flag: "wx" });
  console.log("PASS required practical local + normal public SSH + scoped router accounting + fresh owned session + shared HTTP + Incus + isolated continuity");
} finally {
  try {
  await ssh?.close();
  if (server.exitCode === null && server.signalCode === null) { const closed = once(server, "close"); server.kill("SIGTERM"); await closed; }
  await gatewayLog.close();
  } finally { if (!forwardingCleaned) await cleanupForwarding(); }
}
