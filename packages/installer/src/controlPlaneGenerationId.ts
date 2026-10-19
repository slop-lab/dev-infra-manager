import { createHash } from "node:crypto";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";
import type { CompleteControlPlaneSourcePreflight } from "./controlPlaneSources.js";

const generationDomain = Buffer.from("dim-control-plane-generation-v1", "ascii");

export function controlPlaneGenerationId(config: ControlPlaneConfig, sources: CompleteControlPlaneSourcePreflight): string {
  return controlPlaneGenerationIdFromFields([
    Buffer.from(config.nativeGit.image), Buffer.from(config.ordinaryCi.image),
    sources.nativeGit.config.bytes, sources.nativeGit.readinessToken.bytes,
    sources.ordinaryCi.config.bytes, sources.ordinaryCi.readinessToken.bytes,
    sources.activationTokens.nativeGit.bytes, sources.activationTokens.ordinaryCi.bytes
  ]);
}

export function controlPlaneGenerationIdFromFields(fields: readonly Buffer[]): string {
  const hash = createHash("sha256").update(generationDomain);
  for (const field of fields) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.length));
    hash.update(length).update(field);
  }
  return hash.digest("hex");
}
