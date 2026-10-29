export const sourcePrefix = "packages/gs/" as const;
export const bundleRef = "refs/heads/source-commit" as const;

export type ObjectFormat = "sha1" | "sha256";
export type GitMode = "100644" | "100755" | "120000";
export type DependencyKind = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";

export type ExportArguments = {
  readonly source: string;
  readonly commit: string;
  readonly output: string;
};

export type GitContext = {
  readonly source: string;
  readonly commit: string;
  readonly objectFormat: ObjectFormat;
  readonly tree: string;
  readonly prefixTree: string;
};

export type TreeEntry = {
  readonly sourcePath: string;
  readonly exportPath: string;
  readonly blobId: string;
  readonly mode: GitMode;
  readonly content: Buffer;
};

export type ExportedFile = {
  readonly sourcePath: string;
  readonly exportPath: string;
  readonly blobId: string;
  readonly mode: GitMode;
  readonly sha256: string;
};

export type PackageRecord = {
  readonly name: string;
  readonly sourcePath: string;
  readonly exportPath: string;
  readonly manifestBlobId: string;
  readonly private: boolean;
  readonly version?: string;
};

export type DependencyRecord = {
  readonly from: string;
  readonly name: string;
  readonly kind: DependencyKind;
  readonly specifier: string;
  readonly target?: string;
};

export type LockRecord = {
  readonly sourcePath: "pnpm-lock.yaml";
  readonly blobId: string;
  readonly sha256: string;
};

export type ExportManifest = {
  readonly schemaVersion: 1;
  readonly source: {
    readonly commit: string;
    readonly tree: string;
    readonly prefixTree: string;
    readonly objectFormat: ObjectFormat;
    readonly prefix: typeof sourcePrefix;
  };
  readonly bundle: {
    readonly path: "source-history.bundle";
    readonly ref: typeof bundleRef;
    readonly sha256: string;
  };
  readonly monorepoLock: LockRecord | null;
  readonly files: readonly ExportedFile[];
  readonly packages: readonly PackageRecord[];
  readonly dependencies: readonly DependencyRecord[];
};

export class SourceExportError extends Error {
  readonly name = "SourceExportError";
}
