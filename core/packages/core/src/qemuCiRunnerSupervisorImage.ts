import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import {
  QEMU_CI_COMMON_IMAGE_SCHEMA,
  QEMU_CI_PROJECT_IMAGE_SCHEMA,
  qemuCiCommonImageIdentity,
  qemuCiProjectImageIdentity
} from "./qemuCiRunnerImage.js";
import type { QemuCiProjectHookIdentity } from "./qemuCiRunnerImage.js";
import {
  QEMU_CI_ARCHITECTURE,
  QEMU_CI_APT_SNAPSHOT,
  QEMU_CI_APT_SOURCES,
  QEMU_CI_APT_TLS_CA_CERTIFICATE,
  QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS,
  QEMU_CI_COMMON_PROVISION_SCRIPT,
  QEMU_CI_DISK_SIZE,
  QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM,
  QEMU_CI_GITEA_RUNNER_URL,
  QEMU_CI_GITEA_RUNNER_VERSION,
  QEMU_CI_PACKER_ARCHIVE_CHECKSUM,
  QEMU_CI_PACKER_URL,
  QEMU_CI_PACKER_VERSION,
  QEMU_CI_QEMU_PLUGIN_SOURCE,
  QEMU_CI_QEMU_PLUGIN_ARCHIVE_CHECKSUM,
  QEMU_CI_QEMU_PLUGIN_URL,
  QEMU_CI_QEMU_PLUGIN_VERSION,
  QEMU_CI_QEMU_ARCHITECTURE,
  QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT,
  QEMU_CI_SUPERVISOR_APT_PACKAGE_SPECIFICATIONS,
  QEMU_CI_UBUNTU_CLOUD_IMAGE_KEYRING_SHA256,
  QEMU_CI_UBUNTU_CLOUD_IMAGE_SIGNING_FINGERPRINTS,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SHA256,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_SHA256,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_URL,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_URL,
  QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT,
  QEMU_CI_UBUNTU_IMAGE_URL
} from "./qemuCiRunnerImageAssets.js";
import { QEMU_CI_IMAGE_PREPARE_SCRIPT } from "./qemuCiRunnerImagePrepareAsset.js";
import { QEMU_CI_COMMON_PACKER_TEMPLATE, QEMU_CI_PROJECT_PACKER_TEMPLATE } from "./qemuCiRunnerPackerAssets.js";
import {
  QEMU_CI_SUPERVISOR_BASE_IMAGE,
  QEMU_CI_SUPERVISOR_DOCKERFILE,
  QEMU_CI_SUPERVISOR_IMAGE,
  QEMU_CI_SUPERVISOR_SCRIPT
} from "./qemuCiRunnerSupervisorAssets.js";
import { QEMU_CI_WEBHOOK_SCRIPT } from "./qemuCiRunnerWebhookAsset.js";
import type { StreamingCommandRunner } from "./types.js";

export interface QemuCiRunnerProductionImageInput {
  readonly projectId: string;
  readonly hook: QemuCiProjectHookIdentity;
}

export interface QemuCiRunnerProductionImageKeys {
  readonly commonImageKey: string;
  readonly projectImageKey: string;
}

export function qemuCiRunnerProductionImageKeys(input: QemuCiRunnerProductionImageInput): QemuCiRunnerProductionImageKeys {
  const commonImageKey = qemuCiCommonImageIdentity({
    schema: QEMU_CI_COMMON_IMAGE_SCHEMA,
    architecture: QEMU_CI_ARCHITECTURE,
    qemuArchitecture: QEMU_CI_QEMU_ARCHITECTURE,
    diskSize: QEMU_CI_DISK_SIZE,
    ubuntuImageUrl: QEMU_CI_UBUNTU_IMAGE_URL,
    ubuntuImageChecksum: QEMU_CI_UBUNTU_IMAGE_CHECKSUM,
    ubuntuImageChecksumUrl: QEMU_CI_UBUNTU_IMAGE_CHECKSUM_URL,
    ubuntuImageChecksumSha256: QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SHA256,
    ubuntuImageChecksumSignatureUrl: QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_URL,
    ubuntuImageChecksumSignatureSha256: QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_SHA256,
    ubuntuImageSigningKeyringSha256: QEMU_CI_UBUNTU_CLOUD_IMAGE_KEYRING_SHA256,
    ubuntuImageSigningFingerprints: QEMU_CI_UBUNTU_CLOUD_IMAGE_SIGNING_FINGERPRINTS,
    aptSnapshot: QEMU_CI_APT_SNAPSHOT,
    aptSources: QEMU_CI_APT_SOURCES,
    aptTlsCaCertificate: QEMU_CI_APT_TLS_CA_CERTIFICATE,
    aptPackageSpecifications: [...QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS, ...QEMU_CI_SUPERVISOR_APT_PACKAGE_SPECIFICATIONS],
    packerVersion: QEMU_CI_PACKER_VERSION,
    packerUrl: QEMU_CI_PACKER_URL,
    packerArchiveChecksum: QEMU_CI_PACKER_ARCHIVE_CHECKSUM,
    qemuPluginSource: QEMU_CI_QEMU_PLUGIN_SOURCE,
    qemuPluginVersion: QEMU_CI_QEMU_PLUGIN_VERSION,
    qemuPluginUrl: QEMU_CI_QEMU_PLUGIN_URL,
    qemuPluginArchiveChecksum: QEMU_CI_QEMU_PLUGIN_ARCHIVE_CHECKSUM,
    giteaRunnerVersion: QEMU_CI_GITEA_RUNNER_VERSION,
    giteaRunnerUrl: QEMU_CI_GITEA_RUNNER_URL,
    giteaRunnerArchiveChecksum: QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM,
    packerTemplate: QEMU_CI_COMMON_PACKER_TEMPLATE,
    provisionScript: QEMU_CI_COMMON_PROVISION_SCRIPT,
    imagePrepareScript: QEMU_CI_IMAGE_PREPARE_SCRIPT,
    ubuntuImageVerifyScript: QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT,
    supervisorBuilderBaseImageDigest: QEMU_CI_SUPERVISOR_BASE_IMAGE,
    supervisorBuilderDockerfile: QEMU_CI_SUPERVISOR_DOCKERFILE
  });
  return {
    commonImageKey,
    projectImageKey: qemuCiProjectImageIdentity({
      schema: QEMU_CI_PROJECT_IMAGE_SCHEMA,
      projectId: input.projectId,
      commonIdentity: commonImageKey,
      hook: input.hook,
      absentHookScript: QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT,
      templateDigest: createHash("sha256").update(QEMU_CI_PROJECT_PACKER_TEMPLATE).digest("hex")
    })
  };
}

export async function prepareQemuCiRunnerSupervisorImage(runner: StreamingCommandRunner, stateRoot: string): Promise<string> {
  const assetsParent = path.join(stateRoot, "assets");
  await mkdir(assetsParent, { recursive: true, mode: 0o700 });
  const context = await mkdtemp(path.join(assetsParent, ".qemu-ci-supervisor-"));
  const iidfile = path.join(context, "image-id");
  try {
    const assets: readonly [string, string, number][] = [
      ["Dockerfile", QEMU_CI_SUPERVISOR_DOCKERFILE, 0o600],
      ["ubuntu.sources", QEMU_CI_APT_SOURCES, 0o600],
      ["snapshot-ca.pem", QEMU_CI_APT_TLS_CA_CERTIFICATE, 0o644],
      ["supervise.bash", QEMU_CI_SUPERVISOR_SCRIPT, 0o700],
      ["prepare-image.bash", QEMU_CI_IMAGE_PREPARE_SCRIPT, 0o700],
      ["verify-ubuntu-image.bash", QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT, 0o700],
      ["webhook.py", QEMU_CI_WEBHOOK_SCRIPT, 0o700],
      ["common.pkr.hcl", QEMU_CI_COMMON_PACKER_TEMPLATE, 0o600],
      ["project.pkr.hcl", QEMU_CI_PROJECT_PACKER_TEMPLATE, 0o600],
      ["provision-common.bash", QEMU_CI_COMMON_PROVISION_SCRIPT, 0o700]
    ];
    await Promise.all(assets.map(async ([name, bytes, mode]) => {
      const asset = path.join(context, name);
      await writeFile(asset, bytes, { mode });
      await chmod(asset, mode);
    }));
    const result = await runner.run("docker", ["build", "--iidfile", iidfile, "--tag", QEMU_CI_SUPERVISOR_IMAGE, context]);
    if (result.exitCode !== 0) throw new UserError(`failed to build QEMU runner supervisor: ${result.stderr.trim()}`);
    const imageId = (await readFile(iidfile, "utf8")).trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
      throw new UserError("built QEMU runner supervisor image must be a complete Docker image ID");
    }
    return imageId;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
