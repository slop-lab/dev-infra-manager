/** A language compiler supplies jobs; Git validates candidate identities and execution inputs. */
export type WorkflowJob = {
  readonly name: string;
  readonly kind: "ordinary-sysbox" | "qemu";
  readonly script: string;
  readonly repositories?: readonly string[];
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

export const WORKFLOW_COMPILER_EXTENSION = "dim.ci.workflow-compiler";
export const DEFAULT_WORKFLOW_COMPILER = "dim";

export function workflowCompilerExtension(name: string, compiler: WorkflowCompiler) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !isCandidatePath(compiler.configurationPath)) throw new Error("invalid workflow compiler extension");
  return { kind: WORKFLOW_COMPILER_EXTENSION, name, value: compiler };
}

export function requireWorkflowCompiler(extensions: readonly { readonly kind: string; readonly name: string; readonly value: object }[],
  name = DEFAULT_WORKFLOW_COMPILER): WorkflowCompiler {
  const matches = extensions.filter((entry) => entry.kind === WORKFLOW_COMPILER_EXTENSION && entry.name === name);
  const compiler = matches[0]?.value;
  if (matches.length !== 1 || !compiler || !("configurationPath" in compiler) || typeof compiler.configurationPath !== "string"
    || !isCandidatePath(compiler.configurationPath) || !("compile" in compiler) || typeof compiler.compile !== "function") {
    throw new Error(`workflow compiler '${name}' is unavailable`);
  }
  return compiler as WorkflowCompiler;
}
