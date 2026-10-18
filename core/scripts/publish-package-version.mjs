// @ts-check
import process from "node:process";

/**
 * @param {string} sourceVersion
 * @param {string | undefined} [localVersion]
 */
export function publishPackageVersion(sourceVersion, localVersion = process.env.DIM_LOCAL_BUILD_VERSION) {
  if (localVersion === undefined || localVersion === "") return sourceVersion;
  const escaped = sourceVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^${escaped}-local-[0-9a-f]{64}(?:-dirty)?$`).test(localVersion)) {
    throw new Error(
      `DIM_LOCAL_BUILD_VERSION must extend ${sourceVersion} with an aggregate SHA-256 identity as ${sourceVersion}-local-<aggregate-sha256>[-dirty]`
    );
  }
  return localVersion;
}
