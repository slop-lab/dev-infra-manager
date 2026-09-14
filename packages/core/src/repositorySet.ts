import { parseDocument } from "yaml";
import { UserError } from "./errors.js";
import { normalizeRepositorySet } from "./repositorySetValidation.js";
import type { RepositorySet } from "./repositorySetTypes.js";

export type {
  RepositoryRefNamespace,
  RepositorySet,
  RepositorySetEntry,
  RepositorySetUpstream,
  ResolvedRepositoryConnection
} from "./repositorySetTypes.js";
export {
  mapExternalRefToRepository,
  mapRepositoryRefToExternal,
  resolveRepositoryConnection,
  validateRepositoryRefNamespace
} from "./repositorySetConnection.js";
export {
  assertRepositorySetCanCreateProject,
  assertRepositorySetUrlsArePortable,
  normalizeRepositorySet,
  validateRepositorySet
} from "./repositorySetValidation.js";

export function parseRepositorySetYaml(source: string, label = "repos.yml"): RepositorySet {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new UserError(`${label} is invalid YAML: ${document.errors[0]?.message ?? "unknown parse error"}`);
  }
  return normalizeRepositorySet(document.toJS({ maxAliasCount: 0 }), label);
}
