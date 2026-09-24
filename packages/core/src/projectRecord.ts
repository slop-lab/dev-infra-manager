import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleRecord.js";
import type {
  ProjectPhase,
  ProjectRecord,
  ProjectRepositoryPhase,
  ProjectRepositoryRecord,
  RepositoryConnection
} from "./lifecycleTypes.js";

const PROJECT_FIELDS = [
  "schemaVersion", "id", "name", "gitNamespace", "giteaOrganizationId", "phase",
  "repositories", "createdAt", "updatedAt"
] as const;
const PROJECT_OPTIONAL_FIELDS = ["rootRepositoryAlias", "rootRef", "error"] as const;
const REPOSITORY_FIELDS = [
  "alias", "providerRepoId", "owner", "hostUrl", "workspaceUrl", "phase", "connections",
  "protectedPatterns", "protectionPhase", "createdAt", "updatedAt"
] as const;
const REPOSITORY_OPTIONAL_FIELDS = ["ref", "transferId", "forcePushBlockedPatterns", "error"] as const;
const CONNECTION_FIELDS = ["name", "url"] as const;
const CONNECTION_OPTIONAL_FIELDS = ["refNamespace", "publishBranches"] as const;
const REF_NAMESPACE_OPTIONAL_FIELDS = ["prefix", "fallback", "excludedPrefixes", "branches"] as const;
const NO_REQUIRED_FIELDS: readonly string[] = [];

export function parseProjectRecord(value: unknown): ProjectRecord {
  const record = object(value, "Project state");
  if (record.schemaVersion !== 4) {
    throw new UserError(
      `project '${String(record.name)}' uses unsupported state schema ${String(record.schemaVersion)}; `
      + "expected 4 and DIM does not migrate existing state"
    );
  }
  exactFields(record, { required: PROJECT_FIELDS, optional: PROJECT_OPTIONAL_FIELDS, label: "Project state" });
  const phase = projectPhase(record.phase);
  const giteaOrganizationId = organizationId(record.giteaOrganizationId);
  if (phase === "ready" && giteaOrganizationId === null) {
    throw new UserError("Project state has invalid Gitea organization ID for ready phase");
  }
  const parsed = {
    schemaVersion: 4,
    id: identifier(record.id, "Project state.id"),
    name: validateLifecycleName(text(record.name, "Project state.name"), "project"),
    gitNamespace: validateLifecycleName(text(record.gitNamespace, "Project state.gitNamespace"), "Gitea organization"),
    giteaOrganizationId,
    phase,
    repositories: repositories(record.repositories),
    createdAt: text(record.createdAt, "Project state.createdAt"),
    updatedAt: text(record.updatedAt, "Project state.updatedAt")
  } satisfies ProjectRecord;
  return {
    ...parsed,
    ...(record.rootRepositoryAlias === undefined
      ? {} : { rootRepositoryAlias: text(record.rootRepositoryAlias, "Project state.rootRepositoryAlias") }),
    ...(record.rootRef === undefined ? {} : { rootRef: text(record.rootRef, "Project state.rootRef") }),
    ...(record.error === undefined ? {} : { error: text(record.error, "Project state.error") })
  };
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed)) throw invalid(label);
  return parsed;
}

function repositories(value: unknown): ProjectRepositoryRecord[] {
  if (!Array.isArray(value)) throw invalid("Project state.repositories");
  return value.map((entry, index) => repository(entry, `Project state.repositories[${index}]`));
}

function repository(value: unknown, label: string): ProjectRepositoryRecord {
  const record = object(value, label);
  exactFields(record, { required: REPOSITORY_FIELDS, optional: REPOSITORY_OPTIONAL_FIELDS, label });
  const parsed = {
    alias: validateLifecycleName(text(record.alias, `${label}.alias`), "repository"),
    providerRepoId: text(record.providerRepoId, `${label}.providerRepoId`),
    owner: text(record.owner, `${label}.owner`),
    hostUrl: text(record.hostUrl, `${label}.hostUrl`),
    workspaceUrl: text(record.workspaceUrl, `${label}.workspaceUrl`),
    phase: repositoryPhase(record.phase),
    connections: connections(record.connections, `${label}.connections`),
    protectedPatterns: strings(record.protectedPatterns, `${label}.protectedPatterns`),
    protectionPhase: protectionPhase(record.protectionPhase),
    createdAt: text(record.createdAt, `${label}.createdAt`),
    updatedAt: text(record.updatedAt, `${label}.updatedAt`)
  } satisfies ProjectRepositoryRecord;
  return {
    ...parsed,
    ...(record.ref === undefined ? {} : { ref: text(record.ref, `${label}.ref`) }),
    ...(record.transferId === undefined ? {} : { transferId: text(record.transferId, `${label}.transferId`) }),
    ...(record.forcePushBlockedPatterns === undefined ? {} : {
      forcePushBlockedPatterns: strings(record.forcePushBlockedPatterns, `${label}.forcePushBlockedPatterns`)
    }),
    ...(record.error === undefined ? {} : { error: text(record.error, `${label}.error`) })
  };
}

function connections(value: unknown, label: string): RepositoryConnection[] {
  if (!Array.isArray(value)) throw invalid(label);
  return value.map((entry, index) => connection(entry, `${label}[${index}]`));
}

function connection(value: unknown, label: string): RepositoryConnection {
  const record = object(value, label);
  exactFields(record, { required: CONNECTION_FIELDS, optional: CONNECTION_OPTIONAL_FIELDS, label });
  if (record.name !== "origin") throw invalid(`${label}.name`);
  return {
    name: "origin",
    url: text(record.url, `${label}.url`),
    ...(record.refNamespace === undefined ? {} : {
      refNamespace: refNamespace(record.refNamespace, `${label}.refNamespace`)
    }),
    ...(record.publishBranches === undefined ? {} : {
      publishBranches: stringMap(record.publishBranches, `${label}.publishBranches`)
    })
  };
}

function refNamespace(value: unknown, label: string): NonNullable<RepositoryConnection["refNamespace"]> {
  const record = object(value, label);
  exactFields(record, { required: NO_REQUIRED_FIELDS, optional: REF_NAMESPACE_OPTIONAL_FIELDS, label });
  if (record.fallback !== undefined && typeof record.fallback !== "boolean") throw invalid(`${label}.fallback`);
  return {
    ...(record.prefix === undefined ? {} : { prefix: text(record.prefix, `${label}.prefix`) }),
    ...(record.fallback === undefined ? {} : { fallback: record.fallback }),
    ...(record.excludedPrefixes === undefined ? {} : {
      excludedPrefixes: strings(record.excludedPrefixes, `${label}.excludedPrefixes`)
    }),
    ...(record.branches === undefined ? {} : { branches: stringMap(record.branches, `${label}.branches`) })
  };
}

function projectPhase(value: unknown): ProjectPhase {
  switch (value) {
    case "creating": case "ready": case "error": return value;
    default: throw invalid("Project state.phase");
  }
}

function repositoryPhase(value: unknown): ProjectRepositoryPhase {
  switch (value) {
    case "creating": case "importing": case "ready": case "error": return value;
    default: throw invalid("Project repository phase");
  }
}

function protectionPhase(value: unknown): ProjectRepositoryRecord["protectionPhase"] {
  switch (value) {
    case "pending": case "applied": return value;
    default: throw invalid("Project repository protectionPhase");
  }
}

function organizationId(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid("Gitea organization ID");
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw invalid(label);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const record = object(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, text(entry, `${label}.${key}`)]));
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw invalid(label);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(
  value: Readonly<Record<string, unknown>>,
  fields: {
    readonly required: readonly string[];
    readonly optional: readonly string[];
    readonly label: string;
  }
): void {
  const unknownField = Object.keys(value)
    .find((field) => !fields.required.includes(field) && !fields.optional.includes(field));
  if (unknownField !== undefined) throw new UserError(`${fields.label} contains unknown field '${unknownField}'`);
  const missing = fields.required.find((field) => value[field] === undefined);
  if (missing !== undefined) throw new UserError(`${fields.label}.${missing} is required`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(label);
  return value;
}

function invalid(label: string): UserError {
  return new UserError(`${label} is invalid`);
}
