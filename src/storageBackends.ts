import type { DevInfraConfig, JobPaths, PlannedCommand, ResourceProfile, StorageBackendKind } from "./types.js";

export interface StorageBackend {
  kind: StorageBackendKind;
  mounted: boolean;
  planPrepare(paths: JobPaths, profile: ResourceProfile): PlannedCommand[];
  planCleanup(paths: JobPaths, removeDisk: boolean): PlannedCommand[];
}

export function getStorageBackend(config: DevInfraConfig): StorageBackend {
  switch (config.storageBackend.kind) {
    case "loopback":
      return loopbackStorageBackend;
    case "directory":
      return directoryStorageBackend;
  }
}

const loopbackStorageBackend: StorageBackend = {
  kind: "loopback",
  mounted: true,
  planPrepare(paths, profile) {
    return [
      { command: "truncate", args: ["-s", String(profile.diskBytes), paths.diskImage] },
      { command: "mkfs.ext4", args: ["-F", "-q", paths.diskImage] },
      { command: "mount", args: ["-o", "loop", paths.diskImage, paths.mountPoint], sudo: true },
      { command: "install", args: ["-d", "-m", "0755", paths.workspace, paths.runtimeData], sudo: true },
      { command: "chown", args: ["-R", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, paths.mountPoint], sudo: true }
    ];
  },
  planCleanup(paths, removeDisk) {
    const commands: PlannedCommand[] = [{ command: "umount", args: [paths.mountPoint], sudo: true }];
    if (removeDisk) {
      commands.push({ command: "rm", args: ["-rf", paths.jobRoot, paths.mountPoint], sudo: true });
    }
    return commands;
  }
};

const directoryStorageBackend: StorageBackend = {
  kind: "directory",
  mounted: false,
  planPrepare(paths) {
    return [
      { command: "install", args: ["-d", "-m", "0755", paths.workspace, paths.runtimeData], sudo: true },
      { command: "chown", args: ["-R", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, paths.mountPoint], sudo: true }
    ];
  },
  planCleanup(paths, removeDisk) {
    return removeDisk ? [{ command: "rm", args: ["-rf", paths.jobRoot, paths.mountPoint], sudo: true }] : [];
  }
};
