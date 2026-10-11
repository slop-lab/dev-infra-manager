import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import {
  QEMU_CI_COMMON_IMAGE_SCHEMA,
  QEMU_CI_NO_HOOK_DIGEST,
  QEMU_CI_PROJECT_IMAGE_SCHEMA,
  qemuCiCommonImageIdentity,
  qemuCiProjectImageIdentity
} from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import {
  QEMU_CI_APT_SOURCES,
  QEMU_CI_APT_TLS_CA_CERTIFICATE,
  QEMU_CI_COMMON_PROVISION_SCRIPT,
  QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT,
  QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT
} from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";
import { QEMU_CI_IMAGE_PREPARE_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImagePrepareAsset.js";
import { QEMU_CI_COMMON_PACKER_TEMPLATE, QEMU_CI_PROJECT_PACKER_TEMPLATE } from "../../../../core/packages/core/src/qemuCiRunnerPackerAssets.js";
import { QEMU_CI_SUPERVISOR_BASE_IMAGE, QEMU_CI_SUPERVISOR_DOCKERFILE, QEMU_CI_SUPERVISOR_IMAGE, QEMU_CI_SUPERVISOR_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerSupervisorAssets.js";
import { QEMU_CI_WEBHOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerWebhookAsset.js";
import {
  prepareQemuCiRunnerSupervisorImage,
  qemuCiRunnerProductionImageKeys
} from "../../../../core/packages/core/src/qemuCiRunnerSupervisorImage.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const stateRoots: string[] = [];
const concurrentImageIds = [`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`] as const;
const supervisorAssets = [
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
] as const;

afterEach(async () => {
  await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FailingRunner implements StreamingCommandRunner {
  context: string | undefined;

  async run(command: string, args: string[]): Promise<CommandResult> {
    const context = args.at(-1);
    if (context === undefined) throw new Error("Docker build context is required");
    this.context = context;
    await mkdir(join(context, "docker-residue", "nested"), { recursive: true });
    await writeFile(join(context, "docker-residue", "nested", "partial"), "partial");
    return { command, args, stdout: "", stderr: "build failed", exitCode: 1 };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

interface BuildSnapshot {
  readonly command: string;
  readonly args: readonly string[];
  readonly context: string;
  readonly iidfile: string;
  readonly imageId: string;
  readonly entries: readonly string[];
  readonly assets: readonly {
    readonly name: string;
    readonly bytes: string;
    readonly mode: number;
  }[];
}

class BarrierRunner {
  readonly snapshots: BuildSnapshot[] = [];
  readonly arrivalImageIds: string[] = [];
  readonly completedImageIds: string[] = [];
  private readonly iidContents = new Map<string, string>();
  private arrivals = 0;
  private readonly barrier: Promise<void>;
  private releaseBarrier: () => void = () => {};
  private readonly secondCompletion: Promise<void>;
  private releaseSecondCompletion: () => void = () => {};
  private readonly arrivalReady = new Map<string, Promise<void>>();
  private readonly releaseArrival = new Map<string, () => void>();

  constructor(private readonly imageCount: number, arrivalImageIds: readonly string[]) {
    this.barrier = new Promise((resolve) => {
      this.releaseBarrier = resolve;
    });
    this.secondCompletion = new Promise((resolve) => {
      this.releaseSecondCompletion = resolve;
    });
    for (const imageId of arrivalImageIds) {
      this.arrivalReady.set(imageId, new Promise((resolve) => {
        this.releaseArrival.set(imageId, resolve);
      }));
    }
    const firstArrivalImageId = arrivalImageIds[0];
    if (firstArrivalImageId !== undefined) this.releaseArrival.get(firstArrivalImageId)?.();
  }

  forExpectedImageId(imageId: string): StreamingCommandRunner {
    return {
      run: (command, args) => this.runForImage(command, args, imageId),
      runStreaming: async () => 0
    };
  }

  iidContentsFor(imageId: string): string {
    const iidContent = this.iidContents.get(imageId);
    if (iidContent === undefined) throw new Error(`IID content for ${imageId} was not recorded`);
    return iidContent;
  }

  private async runForImage(command: string, args: string[], imageId: string): Promise<CommandResult> {
    await this.arrivalReady.get(imageId);
    const invocation = this.arrivals;
    this.arrivals += 1;
    this.arrivalImageIds.push(imageId);
    const nextArrivalImageId = [...this.arrivalReady.keys()][invocation + 1];
    if (nextArrivalImageId !== undefined) this.releaseArrival.get(nextArrivalImageId)?.();
    if (this.arrivals === this.imageCount) this.releaseBarrier();
    await this.barrier;
    if (invocation === 0) await this.secondCompletion;

    const context = args.at(-1);
    const iidfileIndex = args.indexOf("--iidfile");
    const iidfile = iidfileIndex < 0 ? undefined : args[iidfileIndex + 1];
    if (context === undefined || iidfile === undefined) {
      throw new Error("complete Docker build arguments are required");
    }
    const assets = await Promise.all(supervisorAssets.map(async ([name]) => ({
      name,
      bytes: await readFile(join(context, name), "utf8"),
      mode: (await stat(join(context, name))).mode & 0o777
    })));
    this.snapshots.push({ command, args, context, iidfile, imageId, entries: (await readdir(context)).sort(), assets });
    this.iidContents.set(imageId, `${imageId}\n`);
    await writeFile(iidfile, `${imageId}\n`);
    this.completedImageIds.push(imageId);
    if (invocation === 1) this.releaseSecondCompletion();
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("QEMU CI supervisor image integration", () => {
  it("derives production common and Project keys from exact construction assets", () => {
    // Given: a Project ID and immutable absent-hook identity.
    const hook = {
      sourceRef: "refs/heads/main",
      sourceCommit: "a".repeat(40),
      kind: "absent" as const,
      digest: QEMU_CI_NO_HOOK_DIGEST
    };

    // When: production image keys are derived.
    const keys = qemuCiRunnerProductionImageKeys({ projectId: "project-id", hook });

    // Then: the common key consumes exact production bytes and the Project key consumes its Project, common, hook, and template digest.
    const commonImageKey = qemuCiCommonImageIdentity({
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
      aptSources: QEMU_CI_APT_SOURCES,
      aptTlsCaCertificate: QEMU_CI_APT_TLS_CA_CERTIFICATE,
      aptPackageSpecifications: [
        "cloud-image-utils=0.33-1", "curl=8.5.0-2ubuntu10.13", "docker.io=29.1.3-0ubuntu3~24.04.2", "git=1:2.43.0-1ubuntu7.3",
        "jq=1.7.1-3ubuntu0.24.04.2", "just=1.21.0-1", "openssh-client=1:9.6p1-3ubuntu13.19",
        "qemu-system-x86=1:8.2.2+ds-0ubuntu1.18", "qemu-utils=1:8.2.2+ds-0ubuntu1.18",
        "socat=1.8.0.0-4ubuntu0.1", "xz-utils=5.6.1+really5.4.5-1ubuntu0.3",
        "ca-certificates=20260601~24.04.1", "cloud-image-utils=0.33-1", "curl=8.5.0-2ubuntu10.13",
        "gpgv=2.4.4-2ubuntu17.6", "openssh-client=1:9.6p1-3ubuntu13.19", "python3=3.12.3-0ubuntu2.1",
        "qemu-system-x86=1:8.2.2+ds-0ubuntu1.18", "qemu-utils=1:8.2.2+ds-0ubuntu1.18",
        "socat=1.8.0.0-4ubuntu0.1", "ubuntu-cloudimage-keyring=2023.11.28.1", "unzip=6.0-28ubuntu4.1",
        "util-linux=2.39.3-9ubuntu6.6", "xz-utils=5.6.1+really5.4.5-1ubuntu0.3"
      ],
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
      packerTemplate: QEMU_CI_COMMON_PACKER_TEMPLATE,
      provisionScript: QEMU_CI_COMMON_PROVISION_SCRIPT,
      imagePrepareScript: QEMU_CI_IMAGE_PREPARE_SCRIPT,
      ubuntuImageVerifyScript: QEMU_CI_UBUNTU_IMAGE_VERIFY_SCRIPT,
      supervisorBuilderBaseImageDigest: QEMU_CI_SUPERVISOR_BASE_IMAGE,
      supervisorBuilderDockerfile: QEMU_CI_SUPERVISOR_DOCKERFILE
    });
    expect(keys).toEqual({
      commonImageKey,
      projectImageKey: qemuCiProjectImageIdentity({
        schema: QEMU_CI_PROJECT_IMAGE_SCHEMA,
        projectId: "project-id",
        commonIdentity: commonImageKey,
        hook,
        absentHookScript: QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT,
        templateDigest: createHash("sha256").update(QEMU_CI_PROJECT_PACKER_TEMPLATE).digest("hex")
      })
    });
  });

  it("isolates concurrent build contexts and returns each invocation's own image ID", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-qemu-supervisor-image-"));
    stateRoots.push(stateRoot);
    const expectedImageIds = concurrentImageIds;
    const runner = new BarrierRunner(concurrentImageIds.length, [expectedImageIds[1], expectedImageIds[0]]);
    const firstPreparation = prepareQemuCiRunnerSupervisorImage(runner.forExpectedImageId(expectedImageIds[0]), stateRoot);
    const secondPreparation = prepareQemuCiRunnerSupervisorImage(runner.forExpectedImageId(expectedImageIds[1]), stateRoot);

    const imageIds = await Promise.all([secondPreparation, firstPreparation]);

    expect(imageIds).toEqual([
      runner.iidContentsFor(expectedImageIds[1]).trim(),
      runner.iidContentsFor(expectedImageIds[0]).trim()
    ]);
    expect(runner.snapshots).toHaveLength(2);
    expect(runner.arrivalImageIds).toEqual([expectedImageIds[1], expectedImageIds[0]]);
    expect(runner.completedImageIds).toEqual([expectedImageIds[0], expectedImageIds[1]]);
    expect(new Set(runner.snapshots.map(({ context }) => context)).size).toBe(2);
    for (const snapshot of runner.snapshots) {
      expect(dirname(snapshot.context)).toBe(join(stateRoot, "assets"));
      expect(dirname(snapshot.iidfile)).toBe(snapshot.context);
      expect(snapshot.command).toBe("docker");
      expect(snapshot.args).toEqual([
        "build", "--iidfile", snapshot.iidfile, "--tag", QEMU_CI_SUPERVISOR_IMAGE, snapshot.context
      ]);
      expect(snapshot.entries).toEqual(supervisorAssets.map(([name]) => name).sort());
      expect(snapshot.assets).toEqual(supervisorAssets.map(([name, bytes, mode]) => ({ name, bytes, mode })));
      expect(runner.iidContentsFor(snapshot.imageId).trim()).toBe(snapshot.imageId);
      await expect(stat(snapshot.context)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("recursively removes the invocation context when Docker build fails", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-qemu-supervisor-failure-"));
    stateRoots.push(stateRoot);
    const runner = new FailingRunner();

    const preparation = prepareQemuCiRunnerSupervisorImage(runner, stateRoot);

    await expect(preparation).rejects.toBeInstanceOf(UserError);
    await expect(preparation).rejects.toThrow(/build failed/);
    expect(runner.context).toBeDefined();
    if (runner.context !== undefined) await expect(stat(runner.context)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
