import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane/plugin";
import { isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
export const candidateArgv = ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"] as const;

export class WorkflowSyntaxError extends Error {}

const jobNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const jobSchema = z.object({
  script: z.string().refine((path) => path.length > 0 && path.length <= 4096 && !path.startsWith("/")
    && !/[\\\x00-\x1f\x7f]/.test(path)
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git")),
  repositories: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)).max(64).refine((ids) => new Set(ids).size === ids.length).optional(),
  runtime: z.enum(["container", "vm"]).default("container")
}).strict().readonly();
const configSchema = z.object({ jobs: z.record(jobNameSchema, jobSchema) }).strict().readonly();

export type WorkflowJob = {
  readonly name: string;
  readonly kind: "ordinary-sysbox" | "qemu";
  readonly script: string;
  readonly repositories?: readonly string[];
  readonly argv: typeof candidateArgv;
};

export const dimWorkflowCompiler = {
  configurationPath: ".dim/ci/runner.yml",
  compile(bytes: Buffer): readonly WorkflowJob[] {
    const parsed = configSchema.safeParse(parseStrictYaml(bytes));
    if (!parsed.success) throw new WorkflowSyntaxError("workflow must define jobs with a script and optional runtime", {
      cause: parsed.error
    });
    const jobs = Object.entries(parsed.data.jobs);
    if (jobs.length > 64) throw new WorkflowSyntaxError("workflow exceeds 64 jobs");
    return jobs.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, job]) => ({ name, kind: job.runtime === "vm" ? "qemu" : "ordinary-sysbox",
        script: job.script, argv: candidateArgv, ...(job.repositories === undefined ? {} : { repositories: job.repositories }) }));
  }
};

function parseStrictYaml(bytes: Buffer): unknown {
  if (bytes.length > 64 * 1024) {
    throw new WorkflowSyntaxError("native candidate runner config exceeds 64 KiB");
  }
  if (bytes.includes(0)) {
    throw new WorkflowSyntaxError("native candidate runner config contains NUL");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new WorkflowSyntaxError("native candidate runner config is not UTF-8", { cause: error });
    }
    throw error;
  }
  const document = parseDocument(source, {
    keepSourceTokens: true,
    merge: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
    version: "1.2"
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new WorkflowSyntaxError("native candidate runner config is not strict YAML");
  }
  visit(document, {
    Alias() {
      throw new WorkflowSyntaxError("native candidate runner config contains an alias");
    },
    Node(_key, node) {
      if (node.anchor !== undefined) {
        throw new WorkflowSyntaxError("native candidate runner config contains an anchor");
      }
      if (node.tag !== undefined) {
        throw new WorkflowSyntaxError("native candidate runner config contains an explicit tag");
      }
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new WorkflowSyntaxError("native candidate runner config contains a non-string mapping key");
      }
      if (pair.key.value === "<<") {
        throw new WorkflowSyntaxError("native candidate runner config contains a merge key");
      }
    }
  });
  return document.toJS({ maxAliasCount: 0 });
}

/** Compiler-only plugin: execution coordinators and workers are independently deployed. */
export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1,
  name: "ci-workflows",
  configure(raw) {
    z.object({}).strict().parse(raw);
    return { workflowCompiler: dimWorkflowCompiler, async start() { return { async close() {} }; } };
  }
};
