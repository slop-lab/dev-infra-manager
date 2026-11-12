import type { StreamingCommandRunner } from "@slop-lab/dim-host-core";
import type { ExecutionGrant, ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";
import type { NativeCandidateVerificationInput } from "./candidate.js";
import type { BackendArtifactSource } from "./artifact-source.js";
export type BackendInput = { readonly grant: ExecutionGrant; readonly root: string;
  readonly artifactNonce?: string;
  readonly runner: StreamingCommandRunner; readonly signal: AbortSignal; readonly acquireCandidate: (input: Pick<NativeCandidateVerificationInput, "workspace" | "scriptFile" | "signal" | "sourceContextDirectory" | "diagnostics">) => Promise<void> };
export interface ExecutionBackend {
  readonly kind: "ordinary-sysbox" | "qemu";
  run(input: BackendInput): Promise<ExecutionResult & { readonly artifactSource?: BackendArtifactSource }>;
  cleanup(runner: StreamingCommandRunner, grant: ExecutionGrant, root: string): Promise<boolean>;
}
