import { isCandidatePath, type WorkflowCompiler } from "@slop-lab/gs-ci-contracts";

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
  if (matches.length !== 1 || compiler === undefined || !isWorkflowCompiler(compiler)) {
    throw new Error(`workflow compiler '${name}' is unavailable`);
  }
  return compiler;
}

function isWorkflowCompiler(value: object): value is WorkflowCompiler {
  return "configurationPath" in value && typeof value.configurationPath === "string"
    && isCandidatePath(value.configurationPath) && "compile" in value && typeof value.compile === "function";
}
