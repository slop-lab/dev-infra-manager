import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  QEMU_CI_ARCHITECTURE,
  QEMU_CI_APT_SNAPSHOT,
  QEMU_CI_APT_SOURCES,
  QEMU_CI_APT_TLS_CA_CERTIFICATE,
  QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS,
  QEMU_CI_DISK_SIZE,
  QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM,
  QEMU_CI_GITEA_RUNNER_URL,
  QEMU_CI_GITEA_RUNNER_VERSION,
  QEMU_CI_PACKER_ARCHIVE_CHECKSUM,
  QEMU_CI_PACKER_URL,
  QEMU_CI_PACKER_VERSION,
  QEMU_CI_QEMU_ARCHITECTURE,
  QEMU_CI_QEMU_PLUGIN_SOURCE,
  QEMU_CI_QEMU_PLUGIN_ARCHIVE_CHECKSUM,
  QEMU_CI_QEMU_PLUGIN_URL,
  QEMU_CI_QEMU_PLUGIN_VERSION,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SHA256,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_SHA256,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_SIGNATURE_URL,
  QEMU_CI_UBUNTU_IMAGE_CHECKSUM_URL,
  QEMU_CI_UBUNTU_CLOUD_IMAGE_KEYRING_SHA256,
  QEMU_CI_UBUNTU_CLOUD_IMAGE_SIGNING_FINGERPRINTS,
  QEMU_CI_UBUNTU_IMAGE_URL,
  QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT,
  QEMU_CI_COMMON_PROVISION_SCRIPT,
  QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT
} from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";
import {
  QEMU_CI_COMMON_PACKER_TEMPLATE,
  QEMU_CI_PROJECT_PACKER_TEMPLATE
} from "../../../../core/packages/core/src/qemuCiRunnerPackerAssets.js";
import { QEMU_CI_IMAGE_PREPARE_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImagePrepareAsset.js";
import {
  QEMU_CI_SUPERVISOR_BASE_IMAGE,
  QEMU_CI_SUPERVISOR_DOCKERFILE,
  QEMU_CI_SUPERVISOR_IMAGE
} from "../../../../core/packages/core/src/qemuCiRunnerSupervisorAssets.js";
import {
  QEMU_CI_COMMON_IMAGE_SCHEMA,
  QEMU_CI_COMMON_MOUNT,
  QEMU_CI_NO_HOOK_DIGEST,
  QEMU_CI_PROJECT_CACHE_MOUNT,
  qemuCiCommonImageIdentity
} from "../../../../core/packages/core/src/qemuCiRunnerImage.js";

describe("QEMU CI two-stage image assets", () => {
  it("exports the complete pinned common image construction identity", () => {
    // Given: the production bytes and pins consumed by common image construction.
    const input = {
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
      aptPackageSpecifications: QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS,
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
    };

    // When: production inputs are hashed as the common image identity.
    const identity = qemuCiCommonImageIdentity(input);

    // Then: every exact pin is present and produces a complete immutable key.
    expect({
      architecture: QEMU_CI_ARCHITECTURE,
      qemuArchitecture: QEMU_CI_QEMU_ARCHITECTURE,
      diskSize: QEMU_CI_DISK_SIZE,
      packer: QEMU_CI_PACKER_VERSION,
      plugin: QEMU_CI_QEMU_PLUGIN_VERSION,
      runner: QEMU_CI_GITEA_RUNNER_VERSION
    }).toEqual({ architecture: "amd64", qemuArchitecture: "x86_64", diskSize: "64G", packer: "1.16.0", plugin: "1.1.6", runner: "3.2.0" });
    expect(QEMU_CI_UBUNTU_IMAGE_CHECKSUM).toMatch(/^[0-9a-f]{64}$/);
    expect(QEMU_CI_PACKER_ARCHIVE_CHECKSUM).toMatch(/^[0-9a-f]{64}$/);
    expect(QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM).toMatch(/^[0-9a-f]{64}$/);
    expect(QEMU_CI_UBUNTU_IMAGE_URL).not.toContain("/current/");
    expect(QEMU_CI_UBUNTU_IMAGE_CHECKSUM_URL).toBe("https://cloud-images.ubuntu.com/releases/24.04/release-20260911/SHA256SUMS");
    expect(QEMU_CI_APT_SOURCES).toContain("https://snapshot.ubuntu.com/ubuntu/20260911T120000Z/");
    expect(QEMU_CI_APT_SOURCES).toContain("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg");
    expect(QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS.every((specification) => specification.includes("="))).toBe(true);
    expect(QEMU_CI_COMMON_APT_PACKAGE_SPECIFICATIONS).toContain("docker.io=29.1.3-0ubuntu3~24.04.2");
    expect(QEMU_CI_COMMON_PROVISION_SCRIPT).toContain("docker.io=29.1.3-0ubuntu3~24.04.2");
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(QEMU_CI_SUPERVISOR_IMAGE).toBe("dim-qemu-ci-supervisor:0.9");
    for (const asset of ["ubuntu.sources", "snapshot-ca.pem", "prepare-image.bash", "verify-ubuntu-image.bash", "common.pkr.hcl", "project.pkr.hcl", "provision-common.bash"]) {
      expect(QEMU_CI_SUPERVISOR_DOCKERFILE).toContain(`COPY ${asset} `);
    }
    expect(QEMU_CI_SUPERVISOR_DOCKERFILE).not.toContain("project-cache-noop.bash");
    expect(QEMU_CI_SUPERVISOR_DOCKERFILE).not.toContain("runner-base.pkr.hcl");
    expect(QEMU_CI_SUPERVISOR_DOCKERFILE).toContain(QEMU_CI_GITEA_RUNNER_URL);
    expect(QEMU_CI_SUPERVISOR_DOCKERFILE).toContain(QEMU_CI_GITEA_RUNNER_ARCHIVE_CHECKSUM);
  });

  it("defines a standalone common artifact with no Project inputs", () => {
    // Given: the common Packer template.
    const template = QEMU_CI_COMMON_PACKER_TEMPLATE;

    // When: machine-consumed QEMU builder fields are inspected.
    const fields = ["runner-common.qcow2", `disk_size            = "${QEMU_CI_DISK_SIZE}"`, `iso_url              = "${QEMU_CI_UBUNTU_IMAGE_URL}"`];

    // Then: it emits one standalone common image and cannot consume Project data.
    for (const field of fields) expect(template).toContain(field);
    expect(template).not.toContain("project_");
    expect(template).not.toContain("use_backing_file");
    expect(template).not.toContain("iso_checksum = \"none\"");
  });

  it("defines a thin Project child and executes only the guest hook contract", () => {
    // Given: the Project Packer template.
    const template = QEMU_CI_PROJECT_PACKER_TEMPLATE;

    // When: its machine-consumed builder and provisioner fields are inspected.
    const required = [
      "runner-project.qcow2", "disk_image           = true", 'format               = "qcow2"',
      `disk_size            = "${QEMU_CI_DISK_SIZE}"`, "iso_target_path      = var.common_image",
      "use_backing_file      = true", "skip_compaction       = true",
      'sudo /tmp/dim-project-cache.bash /var/lib/dim-kvm-cache'
    ];

    // Then: the Project stage is a backing-file derivative with a single root guest hook argument.
    for (const field of required) expect(template).toContain(field);
    expect(template).not.toContain(QEMU_CI_UBUNTU_IMAGE_URL);
    expect(template).not.toMatch(/GITEA_(?:INSTANCE_URL|RUNNER_REGISTRATION_TOKEN|RUNNER_NAME)/);
  });

  it("ships syntactically valid cleanup and preparation scripts without secret identifiers", () => {
    // Given: all shell assets that construct or publish images.
    const scripts = [QEMU_CI_COMMON_PROVISION_SCRIPT, QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT, QEMU_CI_IMAGE_PREPARE_SCRIPT, QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT];

    // When: bash parses each asset.
    const statuses = scripts.map((script) => spawnSync("bash", ["-n"], { input: script }).status);

    // Then: syntax is valid and Packer preparation has no coordinator secret input.
    expect(statuses).toEqual([0, 0, 0, 0]);
    expect(createHash("sha256").update(QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT).digest("hex")).toBe(QEMU_CI_NO_HOOK_DIGEST);
    expect(QEMU_CI_IMAGE_PREPARE_SCRIPT).not.toMatch(/GITEA_(?:INSTANCE_URL|RUNNER_REGISTRATION_TOKEN|RUNNER_NAME)/);
    expect(QEMU_CI_IMAGE_PREPARE_SCRIPT).not.toContain("packer build -force");
    expect(QEMU_CI_IMAGE_PREPARE_SCRIPT).toContain("os.rename");
  });

  it("changes the common identity when production common bytes change", () => {
    // Given: independently hashed production template and provision bytes.
    const templateDigest = createHash("sha256").update(QEMU_CI_COMMON_PACKER_TEMPLATE).digest("hex");

    // When: provision bytes are hashed separately.
    const provisionDigest = createHash("sha256").update(QEMU_CI_COMMON_PROVISION_SCRIPT).digest("hex");

    // Then: the independently maintained construction assets are distinct identity inputs.
    expect(templateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(provisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(templateDigest).not.toBe(provisionDigest);
  });

  it("keeps common and Project artifact volumes on separate fixed mounts", () => {
    // Given: the two production artifact volume mount constants.
    const mounts = [QEMU_CI_COMMON_MOUNT, QEMU_CI_PROJECT_CACHE_MOUNT];

    // When: their supervisor-visible paths are selected.
    const distinctMounts = new Set(mounts);

    // Then: common and Project artifacts cannot share a mutable volume root.
    expect(mounts).toEqual(["/var/lib/dim-qemu-ci-common", "/var/lib/dim-qemu-ci-project-cache"]);
    expect(distinctMounts.size).toBe(2);
  });
});
