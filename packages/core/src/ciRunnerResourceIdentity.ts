import { createHash } from "node:crypto";

export type CiRunnerDockerResourceKind = "container" | "volume";

export function ciRunnerResourceIdentityDigest(
  fields: readonly string[],
  dockerKind: CiRunnerDockerResourceKind
): string {
  const hash = createHash("sha256");
  for (const field of [...fields, dockerKind]) hash.update(`${Buffer.byteLength(field)}:${field};`);
  return hash.digest("hex");
}
