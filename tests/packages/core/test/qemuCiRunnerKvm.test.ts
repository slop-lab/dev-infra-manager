import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QEMU_CI_GITEA_RUNNER_URL, QEMU_CI_UBUNTU_IMAGE_URL } from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";
import {
  prepareQemuCiRunnerSupervisorImage,
  qemuCiRunnerProductionImageKeys
} from "../../../../core/packages/core/src/qemuCiRunnerSupervisorImage.js";

const enabled = process.env.DIM_QEMU_CI_KVM_SMOKE === "1";
const smokeDriver = fileURLToPath(new URL("./qemuCiRunnerKvmSmoke.bash", import.meta.url));
const networkEndpoints = [
  QEMU_CI_UBUNTU_IMAGE_URL,
  QEMU_CI_GITEA_RUNNER_URL,
  "https://releases.hashicorp.com/packer/1.16.0/",
  "https://github.com/hashicorp/packer-plugin-qemu/releases",
  "https://registry-1.docker.io/v2/"
] as const;

class KvmSmokePreconditionError extends Error {
  readonly name = "KvmSmokePreconditionError";
}

class KvmSmokeExecutionError extends Error {
  readonly name = "KvmSmokeExecutionError";

  constructor(readonly exitCode: number) {
    super(`real QEMU image-layer smoke failed with exit code ${exitCode}`);
  }
}

async function requireNetwork(url: string, redirects = 0): Promise<void> {
  if (redirects > 5) throw new KvmSmokePreconditionError(`required network endpoint redirected too many times: ${url}`);
  await new Promise<void>((resolve, reject) => {
    const probe = request(url, { method: "HEAD", headers: { "User-Agent": "dim-qemu-kvm-smoke" } }, (response) => {
      response.resume();
      const status = response.statusCode ?? 500;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        requireNetwork(new URL(location, url).href, redirects + 1).then(resolve, reject);
      } else if (status < 500) resolve();
      else reject(new KvmSmokePreconditionError(`required network endpoint returned HTTP ${response.statusCode}: ${url}`));
    });
    probe.setTimeout(15_000, () => probe.destroy(new KvmSmokePreconditionError(`required network endpoint timed out: ${url}`)));
    probe.on("error", (error) => reject(new KvmSmokePreconditionError(`required network endpoint is unavailable: ${url}: ${error.message}`)));
    probe.end();
  });
}

async function requireKvmHost(runner: ProcessRunner): Promise<void> {
  if (process.arch !== "x64") throw new KvmSmokePreconditionError(`x86-64 host required; process.arch is ${process.arch}`);
  const docker = await runner.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.exitCode !== 0) throw new KvmSmokePreconditionError(`Docker daemon is required: ${docker.stderr.trim()}`);
  let kvm;
  try {
    kvm = await stat("/dev/kvm");
  } catch (error) {
    if (error instanceof Error) throw new KvmSmokePreconditionError(`/dev/kvm character device is required: ${error.message}`);
    throw error;
  }
  if (!kvm.isCharacterDevice()) throw new KvmSmokePreconditionError("/dev/kvm must be a character device");
  try {
    await access("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch (error) {
    if (error instanceof Error) throw new KvmSmokePreconditionError(`/dev/kvm must be readable and writable: ${error.message}`);
    throw error;
  }
  await Promise.all(networkEndpoints.map(requireNetwork));
}

function projectHook(project: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 1
printf 'uid=%s\\narg=%s\\nproject=${project}\\n' "$(id -u)" "$1" >"$1/${project}"
`;
}

describe("QEMU CI production image layers on real KVM", () => {
  it.skipIf(!enabled)("isolates common, Project, and fresh job layers when explicitly enabled", async () => {
    // Given: an explicitly enabled x86-64 host with Docker, writable KVM, and all construction networks.
    const runner = new ProcessRunner();
    await requireKvmHost(runner);
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-qemu-kvm-smoke-"));
    const namespace = `dim-qemu-kvm-${randomUUID()}`;
    const firstProject = "project-alpha";
    const secondProject = "project-beta";
    const firstHook = projectHook(firstProject);
    const secondHook = projectHook(secondProject);
    const firstHookPath = join(stateRoot, `${firstProject}.bash`);
    const secondHookPath = join(stateRoot, `${secondProject}.bash`);
    await Promise.all([
      writeFile(firstHookPath, firstHook, { mode: 0o700 }),
      writeFile(secondHookPath, secondHook, { mode: 0o700 })
    ]);
    const firstKeys = qemuCiRunnerProductionImageKeys({
      projectId: firstProject,
      hook: {
        sourceRef: "refs/heads/main",
        sourceCommit: "a".repeat(40),
        kind: "present",
        digest: createHash("sha256").update(firstHook).digest("hex")
      }
    });
    const secondKeys = qemuCiRunnerProductionImageKeys({
      projectId: secondProject,
      hook: {
        sourceRef: "refs/heads/main",
        sourceCommit: "b".repeat(40),
        kind: "present",
        digest: createHash("sha256").update(secondHook).digest("hex")
      }
    });

    // When: the exact production context builds and its embedded assets construct and boot the full layer scenario.
    try {
      const supervisorImageId = await prepareQemuCiRunnerSupervisorImage(runner, stateRoot);
      const exitCode = await runner.runStreaming("bash", [smokeDriver, namespace, supervisorImageId,
        firstKeys.commonImageKey, firstKeys.projectImageKey, firstHookPath,
        secondKeys.projectImageKey, secondHookPath]);

      // Then: the real driver reports successful layer, guest, immutability, and reuse checks.
      if (exitCode !== 0) throw new KvmSmokeExecutionError(exitCode);
      expect(exitCode).toBe(0);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }, 30 * 60 * 1_000);
});
