import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleState.js";
import { normalizeRepositoryRef } from "./repositoryRef.js";
import {
  boolean,
  branchMap,
  exactKeys,
  object,
  optionalGitUrl,
  optionalLifecycleName,
  optionalRefPrefix,
  optionalString,
  stringArray,
  upstreams
} from "./repositorySetFields.js";
import type { RepositorySet, RepositorySetEntry } from "./repositorySetTypes.js";

export function normalizeRepositorySet(value: unknown, label = "repository set"): RepositorySet {
  const root = object(value, label);
  exactKeys(root, ["schemaVersion", "upstreams", "repositories"], label);
  if (root.schemaVersion !== 1) throw new UserError(`${label}.schemaVersion must be 1`);
  const normalizedUpstreams = upstreams(root.upstreams, label);
  const repositories = object(root.repositories, `${label}.repositories`);
  const normalized: Record<string, RepositorySetEntry> = {};
  for (const [aliasInput, entryValue] of Object.entries(repositories)) {
    const alias = validateLifecycleName(aliasInput, "repo alias");
    const entry = object(entryValue, `${label}.repositories.${alias}`);
    exactKeys(entry, ["url", "upstream", "refPrefix", "fallback", "root", "ref", "protect", "blockForcePush", "import", "publish"], `${label}.repositories.${alias}`);
    const url = optionalGitUrl(entry.url, `${label}.repositories.${alias}.url`);
    const upstream = optionalLifecycleName(entry.upstream, `${label}.repositories.${alias}.upstream`);
    const refPrefix = optionalRefPrefix(entry.refPrefix, `${label}.repositories.${alias}.refPrefix`);
    const fallback = entry.fallback === undefined
      ? false
      : boolean(entry.fallback, `${label}.repositories.${alias}.fallback`);
    const rootFlag = entry.root === undefined ? false : boolean(entry.root, `${label}.repositories.${alias}.root`);
    const ref = optionalString(entry.ref, `${label}.repositories.${alias}.ref`);
    normalized[alias] = {
      ...(url === undefined ? {} : { url }),
      ...(upstream === undefined ? {} : { upstream }),
      ...(refPrefix === undefined ? {} : { refPrefix }),
      fallback,
      root: rootFlag,
      ...(ref === undefined ? {} : { ref: normalizeRepositoryRef(ref) }),
      protectedPatterns: stringArray(entry.protect, `${label}.repositories.${alias}.protect`),
      forcePushBlockedPatterns: stringArray(entry.blockForcePush, `${label}.repositories.${alias}.blockForcePush`),
      importBranches: branchMap(entry.import, `${label}.repositories.${alias}.import`, "import"),
      publishBranches: branchMap(entry.publish, `${label}.repositories.${alias}.publish`)
    };
  }
  if (Object.keys(normalized).length === 0) throw new UserError(`${label}.repositories must not be empty`);
  const set = { schemaVersion: 1 as const, upstreams: normalizedUpstreams, repositories: normalized };
  validateSharedUpstreams(set, label);
  return set;
}

export function validateRepositorySet(value: unknown, label = "repositorySet"): RepositorySet {
  const root = object(value, label);
  exactKeys(root, ["schemaVersion", "upstreams", "repositories"], label);
  if (root.schemaVersion !== 1) throw new UserError(`${label}.schemaVersion must be 1`);
  const normalizedUpstreams = upstreams(root.upstreams, label);
  const repositories = object(root.repositories, `${label}.repositories`);
  const normalized: Record<string, RepositorySetEntry> = {};
  for (const [aliasInput, entryValue] of Object.entries(repositories)) {
    const alias = validateLifecycleName(aliasInput, "repo alias");
    const entry = object(entryValue, `${label}.repositories.${alias}`);
    exactKeys(entry, ["url", "upstream", "refPrefix", "fallback", "root", "ref", "protectedPatterns", "forcePushBlockedPatterns", "importBranches", "publishBranches"], `${label}.repositories.${alias}`);
    const url = optionalGitUrl(entry.url, `${label}.repositories.${alias}.url`);
    const upstream = optionalLifecycleName(entry.upstream, `${label}.repositories.${alias}.upstream`);
    const refPrefix = optionalRefPrefix(entry.refPrefix, `${label}.repositories.${alias}.refPrefix`);
    const fallback = boolean(entry.fallback, `${label}.repositories.${alias}.fallback`);
    const rootFlag = boolean(entry.root, `${label}.repositories.${alias}.root`);
    const ref = optionalString(entry.ref, `${label}.repositories.${alias}.ref`);
    normalized[alias] = {
      ...(url === undefined ? {} : { url }),
      ...(upstream === undefined ? {} : { upstream }),
      ...(refPrefix === undefined ? {} : { refPrefix }),
      fallback,
      root: rootFlag,
      ...(ref === undefined ? {} : { ref: normalizeRepositoryRef(ref) }),
      protectedPatterns: stringArray(
        entry.protectedPatterns,
        `${label}.repositories.${alias}.protectedPatterns`
      ),
      forcePushBlockedPatterns: stringArray(
        entry.forcePushBlockedPatterns,
        `${label}.repositories.${alias}.forcePushBlockedPatterns`
      ),
      importBranches: branchMap(
        entry.importBranches,
        `${label}.repositories.${alias}.importBranches`,
        "import"
      ),
      publishBranches: branchMap(entry.publishBranches, `${label}.repositories.${alias}.publishBranches`)
    };
  }
  if (Object.keys(normalized).length === 0) throw new UserError(`${label}.repositories must not be empty`);
  const set = { schemaVersion: 1 as const, upstreams: normalizedUpstreams, repositories: normalized };
  validateSharedUpstreams(set, label);
  return set;
}

export function assertRepositorySetUrlsArePortable(set: RepositorySet, label = "repos.yml"): void {
  for (const [name, upstream] of Object.entries(set.upstreams)) {
    assertPortableGitUrl(upstream.url, `${label}.upstreams.${name}.url`);
  }
  for (const [alias, entry] of Object.entries(set.repositories)) {
    if (entry.url !== undefined) assertPortableGitUrl(entry.url, `${label}.repositories.${alias}.url`);
  }
}

export function assertRepositorySetCanCreateProject(set: RepositorySet, label = "repository set"): void {
  const roots = Object.entries(set.repositories).filter(([, entry]) => entry.root);
  if (roots.length !== 1) throw new UserError(`${label} must contain exactly one repository with root: true`);
}

function assertPortableGitUrl(url: string, label: string): void {
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url);
  const isScpLike = /^(?:[^/@:]+@)?[^/:]+:.+/.test(url);
  if (!hasScheme && !isScpLike && !url.startsWith("/")) {
    throw new UserError(`${label} must not be a relative filesystem path in a managed root manifest`);
  }
}

function validateSharedUpstreams(set: RepositorySet, label: string): void {
  for (const [alias, entry] of Object.entries(set.repositories)) {
    const entryLabel = `${label}.repositories.${alias}`;
    if (entry.url !== undefined && entry.upstream !== undefined) {
      throw new UserError(`${entryLabel} cannot contain both url and upstream`);
    }
    if (entry.upstream === undefined) {
      if (entry.refPrefix !== undefined || entry.fallback) {
        throw new UserError(`${entryLabel}.refPrefix and fallback require upstream`);
      }
      continue;
    }
    if (!set.upstreams[entry.upstream]) {
      throw new UserError(`${entryLabel}.upstream references unknown upstream '${entry.upstream}'`);
    }
    const hasImports = Object.keys(entry.importBranches).length > 0;
    if ([entry.refPrefix !== undefined, entry.fallback, hasImports].filter(Boolean).length !== 1) {
      throw new UserError(`${entryLabel} must contain exactly one of refPrefix, fallback: true, or import`);
    }
  }
  for (const upstream of Object.keys(set.upstreams)) {
    const members = Object.entries(set.repositories).filter(([, entry]) => entry.upstream === upstream);
    const hasExplicitImports = members.some(([, entry]) => Object.keys(entry.importBranches).length > 0);
    const hasNamespaceImports = members.some(([, entry]) => entry.refPrefix !== undefined || entry.fallback);
    if (hasExplicitImports && hasNamespaceImports) {
      throw new UserError(`${label}.upstreams.${upstream} cannot mix explicit import mappings with refPrefix/fallback namespaces`);
    }
    if (members.filter(([, entry]) => entry.fallback).length > 1) {
      throw new UserError(`${label}.upstreams.${upstream} has more than one fallback repository`);
    }
    const prefixes = members.flatMap(([alias, entry]) => entry.refPrefix ? [{ alias, prefix: entry.refPrefix }] : []);
    for (const [left, a] of prefixes.entries()) {
      for (const b of prefixes.slice(left + 1)) {
        if (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) {
          throw new UserError(`${label} has overlapping ref prefixes for '${a.alias}' and '${b.alias}'`);
        }
      }
    }
    const importedBranches = new Map<string, string>();
    for (const [alias, entry] of members) {
      for (const external of Object.values(entry.importBranches)) {
        const existing = importedBranches.get(external);
        if (existing !== undefined) {
          throw new UserError(`${label}.upstreams.${upstream} maps external branch '${external}' to both '${existing}' and '${alias}'`);
        }
        importedBranches.set(external, alias);
      }
    }
  }
}
