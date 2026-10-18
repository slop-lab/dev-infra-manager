/** A language compiler supplies jobs; Git validates candidate identities and execution inputs. */
export type WorkflowJob = {
  readonly name: string;
  readonly kind: "ordinary-sysbox" | "qemu";
  readonly script: string;
  readonly argv: readonly string[];
};

/** Repository-relative paths cannot escape the immutable candidate tree. */
export function isCandidatePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.startsWith("/")
    && !/[\\\x00-\x1f\x7f]/.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

export function isCandidateArgv(value: readonly string[]): boolean {
  return value.length > 0 && value.length <= 64 && value[0]!.startsWith("/")
    && value.every((arg) => arg.length <= 16384 && !arg.includes("\0"));
}

export interface WorkflowCompiler {
  readonly configurationPath: string;
  compile(bytes: Buffer): readonly WorkflowJob[];
}

export type NativeCandidateRequiredJob = Pick<WorkflowJob, "name" | "kind">;
