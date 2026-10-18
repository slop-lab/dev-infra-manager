import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import type { ExecutionGrant, ExecutionResult } from "./execution.js";
import type { NativeCandidateReadAuthority } from "./candidate.js";
export type BackendInput = { readonly grant: ExecutionGrant; readonly root: string;
  readonly runner: StreamingCommandRunner; readonly signal: AbortSignal; readonly authority: NativeCandidateReadAuthority };
export interface ExecutionBackend {
  readonly kind: "ordinary-sysbox" | "qemu";
  run(input: BackendInput): Promise<ExecutionResult>;
  cleanup(runner: StreamingCommandRunner, grant: ExecutionGrant, root: string): Promise<boolean>;
}
