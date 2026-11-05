import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const values = { DIM_TEST_KVM_IMAGE: requiredEnvironment("DIM_TEST_KVM_IMAGE"),
  DIM_TEST_KVM_STATE_PARENT: requiredEnvironment("DIM_TEST_KVM_STATE_PARENT"),
  DIM_TEST_KVM_PROBE: requiredEnvironment("DIM_TEST_KVM_PROBE"),
  DIM_NATIVE_MULTI_REPOSITORY_IMAGE: requiredEnvironment("DIM_NATIVE_MULTI_REPOSITORY_IMAGE"),
  DIM_GUEST_INTEGRATION_IMAGE: requiredEnvironment("DIM_GUEST_INTEGRATION_IMAGE") };

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("vm-runtime-acceptance requires Linux x86-64");
const kvm = await lstat("/dev/kvm");
if (!kvm.isCharacterDevice()) throw new Error("vm-runtime-acceptance requires the real /dev/kvm character device");
await run("test", ["-r", "/dev/kvm"]); await run("test", ["-w", "/dev/kvm"]);
const kvmDeviceId = (await capture("stat", ["-Lc", "%t:%T", "/dev/kvm"])).trim();
if (!/^[a-f0-9]+:[a-f0-9]+$/.test(kvmDeviceId)) throw new Error("could not identify the real /dev/kvm device");
await run("docker", ["info"]);
const info = await capture("docker", ["info", "--format", "{{json .Runtimes}}"]).catch(() => "");
if (!info.includes("sysbox-runc")) throw new Error("vm-runtime-acceptance requires sysbox-runc");

for (const name of ["DIM_TEST_KVM_IMAGE", "DIM_NATIVE_MULTI_REPOSITORY_IMAGE", "DIM_GUEST_INTEGRATION_IMAGE"] as const) {
  if (!/^sha256:[a-f0-9]{64}$/.test(values[name])) throw new Error(`${name} must be an exact local image ID`);
  const observed = (await capture("docker", ["image", "inspect", values[name], "--format", "{{.Id}}"])) .trim();
  if (observed !== values[name]) throw new Error(`${name} does not match the reviewed local image identity`);
}
const requestedParent = path.resolve(values.DIM_TEST_KVM_STATE_PARENT), parentInfo = await lstat(requestedParent);
const parent = await realpath(requestedParent);
if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parent !== requestedParent || (parentInfo.mode & 0o022) !== 0) {
  throw new Error("DIM_TEST_KVM_STATE_PARENT must be a private non-symlink directory");
}
const requestedProbe = path.resolve(values.DIM_TEST_KVM_PROBE), probeInfo = await lstat(requestedProbe);
const probe = await realpath(requestedProbe);
if (!probeInfo.isFile() || probeInfo.isSymbolicLink() || probe !== requestedProbe || (probeInfo.mode & 0o111) === 0) {
  throw new Error("DIM_TEST_KVM_PROBE must be a reviewed executable regular file");
}
const status = await capture("git", ["status", "--porcelain=v1"]);
if (status.trim()) throw new Error("vm-runtime-acceptance requires a clean exact source tree");
const sourceSha = (await capture("git", ["rev-parse", "HEAD"])).trim(), sourceTree = (await capture("git", ["rev-parse", "HEAD^{tree}"])).trim();
const tests = ["host/plugins/kvm/runtime.test.ts", "host/core/multiRepositoryWorkspaceRuntime.test.ts", "host/core/guestIntegrationRuntime.test.ts"];
await run("pnpm", ["--dir", "tests", "exec", "vitest", "run", ...tests, "--no-file-parallelism"]);
const receipt = process.env.DIM_VM_ACCEPTANCE_RECEIPT ?? path.join(root, ".local/verification", `vm-runtime-acceptance-${sourceSha}.json`);
await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
await writeFile(receipt, `${JSON.stringify({ schemaVersion: 1, sourceSha, sourceTree, observedAt: new Date().toISOString(),
  kvm: { device: "/dev/kvm", deviceId: kvmDeviceId }, images: { kvm: values.DIM_TEST_KVM_IMAGE,
    multiRepository: values.DIM_NATIVE_MULTI_REPOSITORY_IMAGE, guestIntegration: values.DIM_GUEST_INTEGRATION_IMAGE },
  stateParent: parent, probe, tests, outcome: "passed" }, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`vm-runtime-acceptance-ok receipt=${receipt}\n`);

async function run(command: string, args: readonly string[]): Promise<void> {
  const code = await new Promise<number>((resolve, reject) => { const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit" }); child.once("error", reject); child.once("close", (value) => resolve(value ?? 1)); });
  if (code !== 0) throw new Error(`${command} failed with exit ${code}`);
}
async function capture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] }); const stdout: Buffer[] = [], stderr: Buffer[] = []; child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk))); child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk))); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(Buffer.concat(stderr).toString("utf8") || `${command} failed`))); });
}
function requiredEnvironment(name: string): string {
  const value = process.env[name]; if (!value) throw new Error(`vm-runtime-acceptance requires ${name}`); return value;
}
