import process from "node:process";

export function publishPackageVersion(sourceVersion, localVersion = process.env.DIM_LOCAL_BUILD_VERSION) {
  if (localVersion === undefined || localVersion === "") return sourceVersion;
  const escaped = sourceVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^${escaped}-local-[0-9a-f]{7,40}(?:-dirty)?$`).test(localVersion)) {
    throw new Error(
      `DIM_LOCAL_BUILD_VERSION must extend ${sourceVersion} as ${sourceVersion}-local-<git-sha>[-dirty]`
    );
  }
  return localVersion;
}
