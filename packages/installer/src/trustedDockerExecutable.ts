import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, parse, sep } from "node:path";
import { ControlPlaneDockerExecutionError } from "./controlPlaneDockerTypes.js";

const trustedDockerCandidates = ["/usr/local/bin/docker", "/usr/bin/docker"] as const;

type PathKind = "directory" | "file" | "other" | "symlink";

export type DockerPathMetadata = {
  readonly kind: PathKind;
  readonly uid: number;
  readonly mode: number;
};

export type DockerExecutableTrustFailure = "foreign-owned" | "nonexecutable" | "nonregular" | "writable";
export type DockerParentTrustFailure = "foreign-owned" | "nondirectory" | "writable";

export class TrustedDockerExecutableError extends ControlPlaneDockerExecutionError {
  readonly name = "TrustedDockerExecutableError";

  constructor(readonly path: string, readonly reason: DockerExecutableTrustFailure | DockerParentTrustFailure | "absent", options?: ErrorOptions) {
    super(`trusted Docker executable ${path} is ${reason}`, options);
  }
}

export function resolveTrustedSystemDockerExecutable(): string {
  for (const candidate of trustedDockerCandidates) {
    try {
      assertTrustedDockerExecutable(candidate);
      return candidate;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  throw new TrustedDockerExecutableError(trustedDockerCandidates.join(" or "), "absent");
}

export function dockerExecutableTrustFailure(metadata: DockerPathMetadata): DockerExecutableTrustFailure | undefined {
  if (metadata.kind !== "file") return "nonregular";
  if (metadata.uid !== 0) return "foreign-owned";
  if ((metadata.mode & 0o022) !== 0) return "writable";
  if ((metadata.mode & 0o111) === 0) return "nonexecutable";
  return undefined;
}

export function dockerParentTrustFailure(metadata: DockerPathMetadata): DockerParentTrustFailure | undefined {
  if (metadata.kind !== "directory") return "nondirectory";
  if (metadata.uid !== 0) return "foreign-owned";
  if ((metadata.mode & 0o022) !== 0) return "writable";
  return undefined;
}

function assertTrustedDockerExecutable(path: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new TrustedDockerExecutableError(path, "nonregular", { cause: error });
    }
    throw error;
  }
  try {
    const failure = dockerExecutableTrustFailure(metadataFromStat(fstatSync(descriptor)));
    if (failure !== undefined) throw new TrustedDockerExecutableError(path, failure);
  } finally {
    closeSync(descriptor);
  }
  assertTrustedParentChain(dirname(path));
}

function assertTrustedParentChain(path: string): void {
  const root = parse(path).root;
  let current = root;
  const rootFailure = dockerParentTrustFailure(metadataFromStat(lstatSync(root)));
  if (rootFailure !== undefined) throw new TrustedDockerExecutableError(root, rootFailure);
  for (const component of path.slice(root.length).split(sep).filter((value) => value.length > 0)) {
    current = join(current, component);
    const failure = dockerParentTrustFailure(metadataFromStat(lstatSync(current)));
    if (failure !== undefined) throw new TrustedDockerExecutableError(current, failure);
  }
}

function metadataFromStat(stat: Stats): DockerPathMetadata {
  const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
  return { kind, uid: stat.uid, mode: stat.mode };
}
