import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import {
  ciRunnerQemuCommonCacheVolumeName,
  QEMU_CI_COMMON_IMAGE_SCHEMA,
  QEMU_CI_NO_HOOK_DIGEST,
  QEMU_CI_PROJECT_IMAGE_SCHEMA,
  qemuCiCommonImageIdentity,
  qemuCiProjectImageIdentity
} from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import type {
  QemuCiCommonImageIdentityInput,
  QemuCiProjectImageIdentityInput
} from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import { QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";

function commonImageInput(): QemuCiCommonImageIdentityInput {
  return {
    schema: QEMU_CI_COMMON_IMAGE_SCHEMA,
    architecture: "amd64",
    qemuArchitecture: "x86_64",
    diskSize: "64G",
    ubuntuImageUrl: "https://cloud-images.ubuntu.com/releases/24.04/release-20260911/ubuntu-24.04-server-cloudimg-amd64.img",
    ubuntuImageChecksum: "612b2c0cc1bc413a6cb8c38fd611794caf0f2b436c50013d8b3794db12ad7354",
    ubuntuImageChecksumUrl: "https://cloud-images.ubuntu.com/releases/24.04/release-20260911/SHA256SUMS",
    ubuntuImageChecksumSha256: "89be81c6f31ffcd63e9df433e868fc2a651475a45aeb993c0dbd2707747b0185",
    ubuntuImageChecksumSignatureUrl: "https://cloud-images.ubuntu.com/releases/24.04/release-20260911/SHA256SUMS.gpg",
    ubuntuImageChecksumSignatureSha256: "6157c3d73e35044f21308b3daea9619e0f44895289911f004b291bfb3541e1b5",
    ubuntuImageSigningKeyringSha256: "c2d40d925557dbe9a0745c12ca0dc98bed593ce9a6652f1b2faa1ff0858dbf2f",
    ubuntuImageSigningFingerprints: ["843938DF228D22F7B3742BC0D94AA3F0EFE21092", "D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81"],
    aptSnapshot: "20260911T120000Z",
    aptSources: "Types: deb\nURIs: https://snapshot.ubuntu.com/ubuntu/20260911T120000Z/\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n",
    aptTlsCaCertificate: "snapshot TLS CA certificate bytes",
    aptPackageSpecifications: ["curl=8.5.0-2ubuntu10.13", "docker.io=29.1.3-0ubuntu3~24.04.2", "qemu-utils=1:8.2.2+ds-0ubuntu1.18"],
    packerVersion: "1.16.0",
    packerUrl: "https://releases.hashicorp.com/packer/1.16.0/packer_1.16.0_linux_amd64.zip",
    packerArchiveChecksum: "5edcd14ab59b535040c512dbecd6ec9ef976a000b073c19d93e4c431c948581e",
    qemuPluginSource: "github.com/hashicorp/qemu",
    qemuPluginVersion: "1.1.6",
    qemuPluginUrl: "https://releases.hashicorp.com/packer-plugin-qemu/1.1.6/packer-plugin-qemu_1.1.6_linux_amd64.zip",
    qemuPluginArchiveChecksum: "3f735539fbdd0368785babda272b85738866f736415dce59d04b4cb550c4db87",
    giteaRunnerVersion: "3.2.0",
    giteaRunnerUrl: "https://gitea.com/gitea/runner/releases/download/v3.2.0/gitea-runner-3.2.0-linux-amd64.xz",
    giteaRunnerArchiveChecksum: "335d0f12e4fdf2cdc2310e9ce8ad33303d0f6889fe2efa2e1999d2f5614d440f",
    packerTemplate: "common Packer template bytes",
    provisionScript: "common provision script bytes",
    imagePrepareScript: "image preparation script bytes",
    ubuntuImageVerifyScript: "Ubuntu image verification script bytes",
    supervisorBuilderBaseImageDigest: "ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517",
    supervisorBuilderDockerfile: "RUN apt-get install qemu-system-x86=1 packer=1.16.0"
  };
}

function projectImageInput(commonIdentity: string): QemuCiProjectImageIdentityInput {
  return {
    schema: QEMU_CI_PROJECT_IMAGE_SCHEMA,
    projectId: "project-a",
    commonIdentity: createHash("sha256").update(commonIdentity).digest("hex"),
    hook: {
      sourceRef: "refs/heads/main",
      sourceCommit: "1".repeat(40),
      kind: "present",
      digest: createHash("sha256").update("cache hook").digest("hex")
    },
    absentHookScript: QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT,
    templateDigest: createHash("sha256").update("project template").digest("hex")
  };
}

const changedCommonInputs: readonly [string, QemuCiCommonImageIdentityInput][] = [
  ["schema", { ...commonImageInput(), schema: "qemu-ci-common-image-v3" }],
  ["architecture", { ...commonImageInput(), architecture: "arm64" }],
  ["QEMU architecture", { ...commonImageInput(), qemuArchitecture: "aarch64" }],
  ["disk size", { ...commonImageInput(), diskSize: "96G" }],
  ["Ubuntu URL", { ...commonImageInput(), ubuntuImageUrl: "https://cloud-images.ubuntu.com/releases/24.04/release-20260911/changed.img" }],
  ["Ubuntu checksum", { ...commonImageInput(), ubuntuImageChecksum: "a".repeat(64) }],
  ["Ubuntu checksum URL", { ...commonImageInput(), ubuntuImageChecksumUrl: "https://cloud-images.ubuntu.com/releases/24.04/release-20260911/changed-SHA256SUMS" }],
  ["Ubuntu checksum bytes", { ...commonImageInput(), ubuntuImageChecksumSha256: "e".repeat(64) }],
  ["Ubuntu checksum signature URL", { ...commonImageInput(), ubuntuImageChecksumSignatureUrl: "https://cloud-images.ubuntu.com/releases/24.04/release-20260911/changed-SHA256SUMS.gpg" }],
  ["Ubuntu checksum signature bytes", { ...commonImageInput(), ubuntuImageChecksumSignatureSha256: "f".repeat(64) }],
  ["Ubuntu signing keyring bytes", { ...commonImageInput(), ubuntuImageSigningKeyringSha256: "1".repeat(64) }],
  ["Ubuntu signing fingerprints", { ...commonImageInput(), ubuntuImageSigningFingerprints: ["A".repeat(40)] }],
  ["APT snapshot", { ...commonImageInput(), aptSnapshot: "20260912T120000Z" }],
  ["APT source bytes", { ...commonImageInput(), aptSources: "changed Deb822 source bytes" }],
  ["APT TLS CA certificate bytes", { ...commonImageInput(), aptTlsCaCertificate: "changed snapshot TLS CA certificate bytes" }],
  ["pinned Docker package specification", { ...commonImageInput(), aptPackageSpecifications: ["curl=8.5.0-2ubuntu10.13", "docker.io=29.1.3-0ubuntu3~24.04.3", "qemu-utils=1:8.2.2+ds-0ubuntu1.18"] }],
  ["Packer version", { ...commonImageInput(), packerVersion: "1.17.0" }],
  ["Packer URL", { ...commonImageInput(), packerUrl: "https://example.invalid/packer.zip" }],
  ["Packer archive checksum", { ...commonImageInput(), packerArchiveChecksum: "b".repeat(64) }],
  ["QEMU plugin source", { ...commonImageInput(), qemuPluginSource: "example.invalid/qemu" }],
  ["QEMU plugin version", { ...commonImageInput(), qemuPluginVersion: "1.2.0" }],
  ["QEMU plugin URL", { ...commonImageInput(), qemuPluginUrl: "https://example.invalid/qemu.zip" }],
  ["QEMU plugin archive checksum", { ...commonImageInput(), qemuPluginArchiveChecksum: "2".repeat(64) }],
  ["Gitea runner version", { ...commonImageInput(), giteaRunnerVersion: "3.3.0" }],
  ["Gitea runner URL", { ...commonImageInput(), giteaRunnerUrl: "https://example.invalid/gitea-runner.xz" }],
  ["Gitea runner archive checksum", { ...commonImageInput(), giteaRunnerArchiveChecksum: "c".repeat(64) }],
  ["common Packer template bytes", { ...commonImageInput(), packerTemplate: "changed Packer template bytes" }],
  ["common provision script bytes", { ...commonImageInput(), provisionScript: "changed provision script bytes" }],
  ["image preparation script bytes", { ...commonImageInput(), imagePrepareScript: "changed image preparation script bytes" }],
  ["Ubuntu image verification script bytes", { ...commonImageInput(), ubuntuImageVerifyScript: "changed Ubuntu verification bytes" }],
  ["supervisor builder base-image digest", { ...commonImageInput(), supervisorBuilderBaseImageDigest: "ubuntu@sha256:d".concat("d".repeat(63)) }],
  ["supervisor builder Dockerfile bytes", { ...commonImageInput(), supervisorBuilderDockerfile: "RUN apt-get install qemu-system-x86=2 packer=1.16.0" }]
];

const changedProjectInputs: readonly [string, QemuCiProjectImageIdentityInput][] = [
  ["Project ID", { ...projectImageInput("common-key"), projectId: "project-b" }],
  ["common key", { ...projectImageInput("common-key"), commonIdentity: createHash("sha256").update("different-common-key").digest("hex") }],
  ["hook source ref", { ...projectImageInput("common-key"), hook: { ...projectImageInput("common-key").hook, sourceRef: "refs/heads/release" } }],
  ["hook source commit", { ...projectImageInput("common-key"), hook: { ...projectImageInput("common-key").hook, sourceCommit: "2".repeat(40) } }],
  ["hook presence", { ...projectImageInput("common-key"), hook: { ...projectImageInput("common-key").hook, kind: "absent", digest: QEMU_CI_NO_HOOK_DIGEST } }],
  ["present hook digest", { ...projectImageInput("common-key"), hook: { ...projectImageInput("common-key").hook, digest: QEMU_CI_NO_HOOK_DIGEST } }],
  ["template digest", { ...projectImageInput("common-key"), templateDigest: "a".repeat(64) }]
];

describe("QEMU CI image identities", () => {
  it("derives deterministic complete SHA-256 common and Project identities", () => {
    // Given: identical immutable common and Project image inputs.
    const common = commonImageInput();
    const project = projectImageInput("common-key");

    // When: each identity is derived twice.
    const firstCommon = qemuCiCommonImageIdentity(common);
    const secondCommon = qemuCiCommonImageIdentity(common);
    const firstProject = qemuCiProjectImageIdentity(project);
    const secondProject = qemuCiProjectImageIdentity(project);

    // Then: both identities are stable full lowercase SHA-256 digests.
    expect(firstCommon).toBe(secondCommon);
    expect(firstProject).toBe(secondProject);
    expect(firstCommon).toMatch(/^[0-9a-f]{64}$/);
    expect(firstProject).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(changedCommonInputs)("changes the common identity when its %s changes", (_field, changedInput) => {
    // Given: one independently changed immutable common construction input.
    const baseline = commonImageInput();

    // When: common identities are derived.
    const baselineIdentity = qemuCiCommonImageIdentity(baseline);
    const changedIdentity = qemuCiCommonImageIdentity(changedInput);

    // Then: the changed construction input invalidates the common identity.
    expect(changedIdentity).not.toBe(baselineIdentity);
  });

  it.each(changedProjectInputs)("changes the Project identity when its %s changes", (_field, changedInput) => {
    // Given: one independently changed Project image construction input.
    const baseline = projectImageInput("common-key");

    // When: Project identities are derived.
    const baselineIdentity = qemuCiProjectImageIdentity(baseline);
    const changedIdentity = qemuCiProjectImageIdentity(changedInput);

    // Then: the changed input invalidates the Project identity.
    expect(changedIdentity).not.toBe(baselineIdentity);
  });

  it("changes the absent-hook identity when the actual no-op executable bytes change", () => {
    // Given: two absent hooks whose provenance matches their distinct executable bytes.
    const fixture = projectImageInput("common-key");
    const baseline = {
      ...fixture,
      hook: { ...fixture.hook, kind: "absent" as const, digest: QEMU_CI_NO_HOOK_DIGEST }
    };
    const changedScript = `${QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT}\ntrue\n`;
    const changed = {
      ...baseline,
      absentHookScript: changedScript,
      hook: { ...baseline.hook, digest: createHash("sha256").update(changedScript).digest("hex") }
    };

    // When: Project identities are derived from the exact no-op bytes Packer would execute.
    const baselineIdentity = qemuCiProjectImageIdentity(baseline);
    const changedIdentity = qemuCiProjectImageIdentity(changed);

    // Then: changing executable bytes invalidates the Project image identity.
    expect(changedIdentity).not.toBe(baselineIdentity);
  });

  it("rejects a mutable Ubuntu release URL even when paired with a digest", () => {
    // Given: a mutable release/current URL paired with an otherwise digest-shaped input.
    const input = {
      ...commonImageInput(),
      ubuntuImageUrl: "https://cloud-images.ubuntu.com/releases/24.04/release/current/ubuntu-24.04-server-cloudimg-amd64.img"
    };

    // When: the common image identity crosses its immutable-input boundary.
    const derive = () => qemuCiCommonImageIdentity(input);

    // Then: mutable release aliases are rejected rather than cached under a stale digest.
    expect(derive).toThrow(UserError);
    expect(derive).toThrow(/dated Ubuntu release/);
  });

  it("rejects malformed digest-shaped identity fields", () => {
    // Given: malformed common and Project SHA-256 identity fields.
    const malformedCommon = { ...commonImageInput(), ubuntuImageChecksum: "not-a-digest" };
    const malformedProject = { ...projectImageInput("common-key"), commonIdentity: "not-a-digest" };

    // When: identities are derived from malformed digest inputs.
    const commonIdentity = () => qemuCiCommonImageIdentity(malformedCommon);
    const projectIdentity = () => qemuCiProjectImageIdentity(malformedProject);

    // Then: both inputs fail at the typed digest boundary.
    expect(commonIdentity).toThrow(UserError);
    expect(commonIdentity).toThrow(/lowercase SHA-256/);
    expect(projectIdentity).toThrow(UserError);
    expect(projectIdentity).toThrow(/lowercase SHA-256/);
  });

  it("uses one host-scoped common cache volume for distinct Projects and keys", () => {
    // Given: distinct Project and common image identity fixtures.
    const firstProject = projectImageInput("common-key-a");
    const secondProject = { ...projectImageInput("common-key-b"), projectId: "project-b" };

    // When: the shared common cache volume is named for both conceptual callers.
    const firstVolume = ciRunnerQemuCommonCacheVolumeName();
    const secondVolume = ciRunnerQemuCommonCacheVolumeName();

    // Then: host-scoped storage is Project- and key-independent.
    expect(firstProject).not.toEqual(secondProject);
    expect(secondVolume).toBe(firstVolume);
    expect(firstVolume).toBe("dim-ci-qemu-common-cache");
  });
});
