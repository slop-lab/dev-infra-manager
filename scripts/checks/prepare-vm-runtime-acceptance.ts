import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const help = `Usage: node scripts/checks/prepare-vm-runtime-acceptance.ts [--run]

Prepare exact local runtime bindings from the current clean candidate. Requires
Linux x86-64, writable /dev/kvm, Docker with Buildx and sysbox-runc, cc with
static libc support, pnpm, and a filesystem that permits device nodes.

DIM_VM_ACCEPTANCE_ROOT may select a fresh private output directory. --run invokes
the existing hard-fail runner after writing preparation.json and bindings.env.
`;
const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) { process.stdout.write(help); process.exit(0); }
if (args.length > 1 || args.some((argument) => argument !== "--run")) { process.stderr.write(help); process.exit(2); }

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("VM runtime preparation requires Linux x86-64");
for (const command of ["docker", "cc", "pnpm"]) await run("sh", ["-c", 'command -v "$1" >/dev/null', "vm-runtime-tool", command]);
await run("test", ["-c", "/dev/kvm"]); await run("test", ["-r", "/dev/kvm"]); await run("test", ["-w", "/dev/kvm"]);
await run("docker", ["info"]); await run("docker", ["buildx", "version"]);
const runtimes = await capture("docker", ["info", "--format", "{{json .Runtimes}}"]);
if (!runtimes.includes("sysbox-runc")) throw new Error("VM runtime preparation requires registered sysbox-runc");
const sourceStatus = await capture("git", ["status", "--porcelain=v1"]);
if (sourceStatus.trim()) throw new Error("VM runtime preparation requires a clean exact source tree");
const sourceSha = (await capture("git", ["rev-parse", "HEAD"])).trim(), sourceTree = (await capture("git", ["rev-parse", "HEAD^{tree}"])).trim();
const output = path.resolve(process.env.DIM_VM_ACCEPTANCE_ROOT ?? path.join(root, ".local/verification", `vm-runtime-${sourceSha}`));
try { await lstat(output); throw new Error(`VM runtime preparation output already exists: ${output}`); }
catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
await mkdir(output, { recursive: true, mode: 0o700 });
const outputInfo = await lstat(output);
if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() || outputInfo.uid !== process.getuid?.() || (outputInfo.mode & 0o777) !== 0o700) throw new Error("VM runtime preparation output must be private and operator-owned");
const stateParent = path.join(output, "state"); await mkdir(stateParent, { mode: 0o700 });

const imageTag = `dim-vm-runtime:${sourceSha.slice(0, 12)}`;
await run("bash", ["scripts/build-workspace-image.bash"], { ...process.env, DIM_LOCAL_SOURCE_ROOT: root, DIM_LOCAL_IMAGE_BUILD_REF: imageTag });
const imageId = (await capture("docker", ["image", "inspect", imageTag, "--format", "{{.Id}}"])) .trim();
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("workspace build did not produce an exact local image ID");
await run("docker", ["run", "--rm", "--runtime", "runc", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "MKNOD",
  "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges", "--user", "0:0", "--mount", `type=bind,source=${stateParent},target=/state`,
  "--entrypoint", "/bin/sh", imageId, "-c", "mknod /state/.device-check c 10 232 && test -c /state/.device-check && rm /state/.device-check"]);

const probeSource = path.join(output, "kvm-ioctl-probe.c"), probe = path.join(output, "kvm-ioctl-probe");
await writeFile(probeSource, `#include <fcntl.h>\n#include <linux/kvm.h>\n#include <stdio.h>\n#include <sys/ioctl.h>\n#include <unistd.h>\nint main(void){int fd=open("/dev/kvm",O_RDWR|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return 2;if(ioctl(fd,KVM_GET_API_VERSION)!=12){close(fd);return 3;}int vm=ioctl(fd,KVM_CREATE_VM,0);if(vm<0){close(fd);return 4;}close(vm);close(fd);puts("kvm-create-vm-ok");return 0;}\n`, { mode: 0o600, flag: "wx" });
await run("cc", ["-O2", "-static", "-Wall", "-Wextra", "-Werror", "-o", probe, probeSource]);
const probeSha256 = createHash("sha256").update(await readFile(probe)).digest("hex");
const acceptanceReceipt = path.join(output, "acceptance.json");
const bindings = { DIM_TEST_KVM_IMAGE: imageId, DIM_TEST_KVM_STATE_PARENT: stateParent, DIM_TEST_KVM_PROBE: probe,
  DIM_TEST_KVM_PROBE_SHA256: probeSha256, DIM_NATIVE_MULTI_REPOSITORY_IMAGE: imageId,
  DIM_GUEST_INTEGRATION_IMAGE: imageId, DIM_VM_ACCEPTANCE_RECEIPT: acceptanceReceipt } as const;
await writeFile(path.join(output, "bindings.env"), `${Object.entries(bindings).map(([name, value]) => `${name}=${value}`).join("\n")}\n`, { mode: 0o600, flag: "wx" });
await writeFile(path.join(output, "preparation.json"), `${JSON.stringify({ schemaVersion: 1, sourceSha, sourceTree, preparedAt: new Date().toISOString(),
  image: { tag: imageTag, id: imageId }, probe: { path: probe, sha256: probeSha256 }, stateParent, acceptanceReceipt }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`vm-runtime-prepared root=${output} image=${imageId} probeSha256=${probeSha256}\n`);
if (args[0] === "--run") await run(process.execPath, ["scripts/checks/vm-runtime-acceptance.ts"], { ...process.env, ...bindings });

async function run(command: string, commandArgs: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const code = await new Promise<number>((resolve, reject) => { const child = spawn(command, commandArgs, { cwd: root, env, stdio: "inherit" }); child.once("error", reject); child.once("close", (value) => resolve(value ?? 1)); });
  if (code !== 0) throw new Error(`${command} failed with exit ${code}`);
}
async function capture(command: string, commandArgs: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => { const child = spawn(command, commandArgs, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] }); const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk))); child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk))); child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(Buffer.concat(stderr).toString("utf8") || `${command} failed`))); });
}
