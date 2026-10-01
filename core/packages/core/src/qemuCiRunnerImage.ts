import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { GiteaCredentials, LifecycleOptions, ProjectRecord, QemuCiProjectHookProvenance } from "./lifecycleTypes.js";
import { resolveProtectedRootSnapshotLocked, type ProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import { QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT } from "./qemuCiRunnerImageAssets.js";
import type { StreamingCommandRunner } from "./types.js";

export const QEMU_CI_COMMON_IMAGE_SCHEMA = "qemu-ci-common-image-v2";
export const QEMU_CI_PROJECT_IMAGE_SCHEMA = "qemu-ci-project-image-v2";
export const QEMU_CI_COMMON_MOUNT = "/var/lib/dim-qemu-ci-common";
export const QEMU_CI_PROJECT_MOUNT = "/var/lib/dim-qemu-ci-project";
export const QEMU_CI_PROJECT_CACHE_MOUNT = "/var/lib/dim-qemu-ci-project-cache";
export const QEMU_CI_NO_HOOK_DIGEST = "7824a5223feb3e6c4b5156d66f529b9b0bafe2a8e0ac528c4ae9005b76c80a43";

export interface QemuCiCommonImageIdentityInput {
  readonly schema: string; readonly architecture: string; readonly qemuArchitecture: string; readonly diskSize: string;
  readonly ubuntuImageUrl: string; readonly ubuntuImageChecksum: string; readonly ubuntuImageChecksumUrl: string;
  readonly ubuntuImageChecksumSha256: string; readonly ubuntuImageChecksumSignatureUrl: string;
  readonly ubuntuImageChecksumSignatureSha256: string; readonly ubuntuImageSigningKeyringSha256: string;
  readonly ubuntuImageSigningFingerprints: readonly string[];
  readonly aptSnapshot: string; readonly aptSources: string; readonly aptTlsCaCertificate: string;
  readonly aptPackageSpecifications: readonly string[];
  readonly packerVersion: string; readonly packerUrl: string; readonly packerArchiveChecksum: string;
  readonly qemuPluginSource: string; readonly qemuPluginVersion: string; readonly qemuPluginUrl: string;
  readonly qemuPluginArchiveChecksum: string; readonly giteaRunnerVersion: string; readonly giteaRunnerUrl: string;
  readonly giteaRunnerArchiveChecksum: string; readonly packerTemplate: string; readonly provisionScript: string;
  readonly imagePrepareScript: string; readonly ubuntuImageVerifyScript: string;
  readonly supervisorBuilderBaseImageDigest: string; readonly supervisorBuilderDockerfile: string;
}

export type QemuCiProjectHookIdentity = QemuCiProjectHookProvenance;

export interface QemuCiProjectImageIdentityInput {
  readonly schema: string; readonly projectId: string; readonly commonIdentity: string;
  readonly hook: QemuCiProjectHookIdentity; readonly absentHookScript: string; readonly templateDigest: string;
}

export interface PrepareQemuProjectHookInput {
  readonly runner: StreamingCommandRunner; readonly options: LifecycleOptions; readonly project: ProjectRecord;
  readonly credentials?: GiteaCredentials;
}

export type PreparedQemuProjectHook = QemuCiProjectHookProvenance & { readonly path: string };

export interface PrepareQemuProjectHookFromSnapshotInput {
  readonly stateRoot: string; readonly snapshot: ProtectedRootSnapshot;
}

export interface RestorePersistedQemuProjectHookInput {
  readonly stateRoot: string; readonly projectId: string; readonly provenance: QemuCiProjectHookProvenance;
}

export function qemuCiCommonImageIdentity(input: QemuCiCommonImageIdentityInput): string {
  const releaseBase = input.ubuntuImageUrl.match(/^(https:\/\/cloud-images[.]ubuntu[.]com\/releases\/24[.]04\/release-[0-9]{8})\//)?.[0];
  if (releaseBase === undefined || !input.ubuntuImageChecksumUrl.startsWith(releaseBase) || !input.ubuntuImageChecksumSignatureUrl.startsWith(releaseBase)) {
    throw new UserError("Ubuntu image and signed checksums must use one dated Ubuntu release");
  }
  assertDigest(input.ubuntuImageChecksum, "Ubuntu image checksum");
  assertDigest(input.ubuntuImageChecksumSha256, "Ubuntu checksum file");
  assertDigest(input.ubuntuImageChecksumSignatureSha256, "Ubuntu checksum signature");
  assertDigest(input.ubuntuImageSigningKeyringSha256, "Ubuntu cloud-image signing keyring");
  assertDigest(input.packerArchiveChecksum, "Packer archive checksum");
  assertDigest(input.qemuPluginArchiveChecksum, "QEMU plugin archive checksum");
  assertDigest(input.giteaRunnerArchiveChecksum, "Gitea runner archive checksum");
  assertImageDigest(input.supervisorBuilderBaseImageDigest, "supervisor builder base image");
  return identity("dim-qemu-ci-common-image", [
    "schema", input.schema, "architecture", input.architecture, "qemuArchitecture", input.qemuArchitecture, "diskSize", input.diskSize,
    "ubuntuImageUrl", input.ubuntuImageUrl, "ubuntuImageChecksum", input.ubuntuImageChecksum,
    "ubuntuImageChecksumUrl", input.ubuntuImageChecksumUrl, "ubuntuImageChecksumSha256", input.ubuntuImageChecksumSha256,
    "ubuntuImageChecksumSignatureUrl", input.ubuntuImageChecksumSignatureUrl,
    "ubuntuImageChecksumSignatureSha256", input.ubuntuImageChecksumSignatureSha256,
    "ubuntuImageSigningKeyringSha256", input.ubuntuImageSigningKeyringSha256,
    "ubuntuImageSigningFingerprints", ...input.ubuntuImageSigningFingerprints,
    "aptSnapshot", input.aptSnapshot, "aptSources", input.aptSources,
    "aptTlsCaCertificate", input.aptTlsCaCertificate,
    "aptPackageSpecifications", ...input.aptPackageSpecifications,
    "packerVersion", input.packerVersion, "packerUrl", input.packerUrl,
    "packerArchiveChecksum", input.packerArchiveChecksum,
    "qemuPluginSource", input.qemuPluginSource, "qemuPluginVersion", input.qemuPluginVersion,
    "qemuPluginUrl", input.qemuPluginUrl, "qemuPluginArchiveChecksum", input.qemuPluginArchiveChecksum,
    "giteaRunnerVersion", input.giteaRunnerVersion, "giteaRunnerUrl", input.giteaRunnerUrl,
    "giteaRunnerArchiveChecksum", input.giteaRunnerArchiveChecksum, "packerTemplate", input.packerTemplate,
    "provisionScript", input.provisionScript, "imagePrepareScript", input.imagePrepareScript,
    "ubuntuImageVerifyScript", input.ubuntuImageVerifyScript,
    "supervisorBuilderBaseImageDigest", input.supervisorBuilderBaseImageDigest,
    "supervisorBuilderDockerfile", input.supervisorBuilderDockerfile
  ]);
}

export function qemuCiProjectImageIdentity(input: QemuCiProjectImageIdentityInput): string {
  assertDigest(input.commonIdentity, "common image identity");
  assertDigest(input.templateDigest, "Project template digest");
  assertCommit(input.hook.sourceCommit);
  if (!input.hook.sourceRef.startsWith("refs/heads/")) throw new UserError("Project hook source ref must be a concrete branch");
  assertDigest(input.hook.digest, "Project hook digest");
  if (input.hook.kind === "absent" && input.hook.digest !== createHash("sha256").update(input.absentHookScript).digest("hex")) {
    throw new UserError("absent hook digest must match the exact no-hook executable bytes");
  }
  return identity("dim-qemu-ci-project-image", [
    "schema", input.schema, "projectId", input.projectId, "commonIdentity", input.commonIdentity,
    "hookSourceRef", input.hook.sourceRef, "hookSourceCommit", input.hook.sourceCommit,
    "hookKind", input.hook.kind, "hookDigest", input.hook.digest,
    ...(input.hook.kind === "absent" ? ["absentHookScript", input.absentHookScript] : []),
    "templateDigest", input.templateDigest
  ]);
}

export function ciRunnerQemuCommonCacheVolumeName(): string {
  return "dim-ci-qemu-common-cache";
}

export async function prepareQemuProjectHook(input: PrepareQemuProjectHookInput): Promise<PreparedQemuProjectHook> {
  const snapshot = await resolveProtectedRootSnapshotLocked({
    runner: input.runner,
    options: input.options,
    project: input.project,
    ...(input.credentials === undefined ? {} : { credentials: input.credentials })
  });
  return prepareQemuProjectHookFromSnapshot({ stateRoot: input.options.stateRoot, snapshot });
}

export async function restorePersistedQemuProjectHook(input: RestorePersistedQemuProjectHookInput): Promise<PreparedQemuProjectHook> {
  assertProjectId(input.projectId);
  assertCommit(input.provenance.sourceCommit);
  if (!input.provenance.sourceRef.startsWith("refs/heads/")) throw new UserError("Project hook source ref must be a concrete branch");
  assertDigest(input.provenance.digest, "Project hook digest");
  if (input.provenance.kind === "absent" && input.provenance.digest !== QEMU_CI_NO_HOOK_DIGEST) throw new UserError("absent hook digest must match the exact no-hook executable bytes");
  const paths = qemuProjectHookArtifactPaths(input.stateRoot, input.projectId, input.provenance);
  const expectedProvenance = qemuProjectHookProvenanceBytes(input.provenance);
  try {
    const [bytes, provenance, metadata] = await Promise.all([readFile(paths.scriptPath), readFile(paths.provenancePath, "utf8"), stat(paths.scriptPath)]);
    if (createHash("sha256").update(bytes).digest("hex") !== input.provenance.digest) {
      throw new UserError(`persisted hook bytes do not match digest '${input.provenance.digest}'`);
    }
    if (provenance !== expectedProvenance) throw new UserError(`persisted hook provenance does not match commit '${input.provenance.sourceCommit}'`);
    if ((metadata.mode & 0o777) !== 0o500) throw new UserError(`persisted hook executable mode is invalid for digest '${input.provenance.digest}'`);
    return { ...input.provenance, path: paths.scriptPath };
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (hasCode(error, "ENOENT")) throw new UserError(`persisted QEMU Project hook artifact is missing for digest '${input.provenance.digest}'`);
    throw new UserError(`failed to restore persisted QEMU Project hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function removeQemuProjectImageState(stateRoot: string, projectId: string): Promise<void> {
  assertProjectId(projectId);
  await rm(join(stateRoot, "assets", "qemu-ci-projects", projectId), { recursive: true, force: true });
}

export async function prepareQemuProjectHookFromSnapshot(
  input: PrepareQemuProjectHookFromSnapshotInput
): Promise<PreparedQemuProjectHook> {
  const snapshot = input.snapshot;
  const source = join(snapshot.rootSnapshotPath, ".dim", "ci", "qemu-cache.bash");
  let bytes: Buffer;
  let kind: QemuCiProjectHookProvenance["kind"];
  try {
    bytes = await readFile(source);
    kind = "present";
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    bytes = Buffer.from(QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT);
    kind = "absent";
  }
  const provenance: QemuCiProjectHookProvenance = {
    sourceRef: snapshot.rootRef,
    sourceCommit: snapshot.rootCommit,
    kind,
    digest: createHash("sha256").update(bytes).digest("hex")
  };
  if (kind === "absent" && provenance.digest !== QEMU_CI_NO_HOOK_DIGEST) {
    throw new UserError("QEMU no-hook executable digest does not match its declared identity");
  }
  return publishHook({ stateRoot: input.stateRoot, projectId: snapshot.project.id, bytes, provenance });
}

async function publishHook(input: {
  readonly stateRoot: string; readonly projectId: string; readonly bytes: Buffer; readonly provenance: QemuCiProjectHookProvenance;
}): Promise<PreparedQemuProjectHook> {
  const hooks = join(input.stateRoot, "assets", "qemu-ci-projects", input.projectId, "hooks", input.provenance.sourceCommit);
  const { directory, scriptPath, provenancePath } = qemuProjectHookArtifactPaths(input.stateRoot, input.projectId, input.provenance);
  const provenanceBytes = qemuProjectHookProvenanceBytes(input.provenance);
  const release = await new LifecycleState(input.stateRoot).acquireQemuProjectHookPublicationLock(input.projectId);
  try {
    const existing = await existingHook({ scriptPath, provenancePath, bytes: input.bytes, provenanceBytes, provenance: input.provenance });
    if (existing !== undefined) return existing;
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(hooks, `.hook-${input.provenance.digest}-`));
    try {
      await writeFile(join(temporary, "cache.bash"), input.bytes, { mode: 0o500 });
      await writeFile(join(temporary, "provenance.json"), provenanceBytes, { mode: 0o400 });
      await chmod(temporary, 0o500);
      await rename(temporary, directory);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return { ...input.provenance, path: scriptPath };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`failed to publish QEMU Project hook: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await release();
  }
}

async function existingHook(
  input: {
    readonly scriptPath: string;
    readonly provenancePath: string;
    readonly bytes: Buffer;
    readonly provenanceBytes: string;
    readonly provenance: QemuCiProjectHookProvenance;
  }
): Promise<PreparedQemuProjectHook | undefined> {
  try {
    if (!(await readFile(input.scriptPath)).equals(input.bytes)) {
      throw new UserError(`mismatched existing hook bytes for digest '${input.provenance.digest}'`);
    }
    if (await readFile(input.provenancePath, "utf8") !== input.provenanceBytes) {
      throw new UserError(`mismatched existing hook provenance for commit '${input.provenance.sourceCommit}'`);
    }
    if (((await stat(input.scriptPath)).mode & 0o777) !== 0o500) {
      throw new UserError(`existing hook executable mode is invalid for digest '${input.provenance.digest}'`);
    }
    return { ...input.provenance, path: input.scriptPath };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function identity(domain: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of [domain, ...fields]) hash.update(`${Buffer.byteLength(field)}:${field};`);
  return hash.digest("hex");
}

function qemuProjectHookArtifactPaths(stateRoot: string, projectId: string, provenance: QemuCiProjectHookProvenance): {
  readonly directory: string; readonly scriptPath: string; readonly provenancePath: string;
} {
  const directory = join(stateRoot, "assets", "qemu-ci-projects", projectId, "hooks", provenance.sourceCommit, `${provenance.kind}-${provenance.digest}`);
  return { directory, scriptPath: join(directory, "cache.bash"), provenancePath: join(directory, "provenance.json") };
}

function qemuProjectHookProvenanceBytes(provenance: QemuCiProjectHookProvenance): string {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new UserError(`${label} must be a lowercase SHA-256 digest`);
}

function assertCommit(value: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new UserError("Project hook source commit must be a complete Git commit");
}

function assertProjectId(value: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(value)) throw new UserError(`project ID '${value}' is invalid`);
}

function assertImageDigest(value: string, label: string): void {
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(value)) throw new UserError(`${label} must be a lowercase SHA-256 digest`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
