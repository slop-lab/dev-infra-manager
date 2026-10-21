import { isAbsolute } from "node:path";
import { z } from "zod";
import type { WebPlugin, WebPluginContext, WebPluginRuntime } from "@slop-lab/dim-web/plugin-api";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { createNativeGitOperator, nativeGitOperations, nativeGitProjectSchema } from "@slop-lab/dim-native-git-client";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const controllerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const projectsSchema = z.array(nativeGitProjectSchema).max(1000).refine((projects) => new Set(projects.map(({ projectId }) => projectId)).size === projects.length);
const descriptor = z.object({ name: z.string(), description: z.string().max(2000), access: z.enum(["read", "operator", "reviewer"]) }).strict();
const controllerSchema = z.object({ id: controllerId, title: z.string().min(1).max(256), status: z.enum(["ready", "unavailable"]), reviewerId: identifier.optional(),
  projects: projectsSchema, operations: z.array(descriptor).max(128) }).strict();
const discoverySchema = z.object({ schemaVersion: z.literal(1), generationId: z.string().regex(/^[a-f0-9]{64}$/), reviewerId: identifier,
  projects: projectsSchema, operations: z.array(descriptor).max(128) }).strict();
const file = z.string().refine(isAbsolute);
const configSchema = z.object({ reviewerConnection: file, promoterConnection: file.optional(), syncConnection: file.optional(),
  projects: z.array(z.object({ projectId: identifier, name: z.string().min(1).max(128).optional(), repositoryIds: z.array(identifier).min(1).max(64)
    .refine((ids) => new Set(ids).size === ids.length) }).strict()).min(1).max(1000).refine((projects) => new Set(projects.map(({ projectId }) => projectId)).size === projects.length) }).strict();
const catalogOperation: Operation = { name: "projects.list", description: "Discover controllers, projects and repositories", access: "read",
  parseInput: (input) => z.object({}).strict().default({}).parse(input), parseOutput: (output) => z.object({ controllers: z.array(controllerSchema).max(64) }).strict().parse(output) };
function wrapped(operation: Operation): Operation {
  return { ...operation, parseInput(value) {
    const { controllerId: selected, ...input } = z.record(z.string(), z.unknown()).parse(value);
    const parsed = z.record(z.string(), z.unknown()).parse(operation.parseInput(input));
    return { controllerId: controllerId.parse(selected), ...parsed };
  } };
}
export const operations: readonly Operation[] = [catalogOperation, ...nativeGitOperations.filter(({ name }) => name !== "projects.list").map(wrapped)];
function selectedInput(input: unknown) {
  const { controllerId: selected, ...value } = z.record(z.string(), z.unknown()).parse(input);
  return { controllerId: controllerId.parse(selected), value };
}
async function automatic(context: WebPluginContext): Promise<WebPluginRuntime> {
  let controllers: Array<z.infer<typeof controllerSchema>> = [];
  const generations = new Map<string, string>();
  async function discover() {
    controllers = await Promise.all(context.controllers.map(async (controller) => {
      try {
        const expected = generations.get(controller.id);
        const description = discoverySchema.parse(await controller.run(["project", "console", "describe", ...(expected ? ["--expected-generation", expected] : [])]));
        if (expected && description.generationId !== expected) throw new Error("Controller generation changed; reconnect this feature");
        for (const operation of description.operations) if (!nativeGitOperations.some((known) => known.name === operation.name && known.access === operation.access)) throw new Error("unknown controller operation");
        generations.set(controller.id, description.generationId);
        return { id: controller.id, title: controller.id, status: "ready" as const, reviewerId: description.reviewerId, projects: description.projects, operations: description.operations };
      } catch { return { id: controller.id, title: controller.id, status: "unavailable" as const, projects: [], operations: [] }; }
    }));
    return { controllers };
  }
  await discover();
  return {
    operations,
    async invoke(name, input) {
      if (name === "projects.list") return discover();
      const selected = selectedInput(input), controller = context.controllers.find(({ id }) => id === selected.controllerId);
      if (!controller || !controllers.some(({ id, status, operations }) => id === selected.controllerId && status === "ready" && operations.some((operation) => operation.name === name))) throw new Error("Controller operation is unavailable");
      const scoped = z.object({ projectId: identifier, repositoryId: identifier }).passthrough().parse(selected.value);
      if (!controllers.find(({ id }) => id === selected.controllerId)?.projects.some((project) => project.projectId === scoped.projectId && project.repositoryIds.includes(scoped.repositoryId))) throw new Error("Project repository is outside this controller scope");
      const operation = nativeGitOperations.find((operation) => operation.name === name);
      if (!operation) throw new Error("Unknown Native Git operation");
      const parsed = operation.parseInput(selected.value);
      const generation = generations.get(selected.controllerId);
      if (!generation) throw new Error("Controller serving generation has not been attested");
      return operation.parseOutput(await controller.run(["project", "console", "invoke", name, "--expected-generation", generation, "--input", JSON.stringify(parsed)]));
    }
  };
}
export const webPlugin: WebPlugin = {
  id: "native-git", title: "Git review", description: "Controller projects, repository proposals, review evidence and protected promotion", operations,
  assets: { "panel.js": new URL("./assets/panel.js", import.meta.url) }, browserEntry: "panel.js",
  autoConnect: automatic,
  async create(input) {
    const config = configSchema.parse(input), projects = config.projects.map((project) => ({ ...project, name: project.name ?? project.projectId }));
    const operator = await createNativeGitOperator({ reviewerConnection: config.reviewerConnection, ...(config.promoterConnection ? { promoterConnection: config.promoterConnection } : {}),
      ...(config.syncConnection ? { syncConnection: config.syncConnection } : {}), projects: async () => projects });
    const available = operator.operations;
    return {
      operations: [catalogOperation, ...available.filter(({ name }) => name !== "projects.list").map(wrapped)],
      async invoke(name, input) {
        if (name === "projects.list") {
          const catalog = z.object({ reviewerId: identifier, projects: projectsSchema }).strict().parse(await operator.invoke(name, {}));
          return { controllers: [{ id: "direct", title: "Direct connection", status: "ready", ...catalog,
            operations: available.map(({ name, description, access }) => ({ name, description, access })) }] };
        }
        const selected = selectedInput(input);
        if (selected.controllerId !== "direct") throw new Error("Controller is outside this Web plugin's configured scope");
        return operator.invoke(name, selected.value);
      }
    };
  }
};
