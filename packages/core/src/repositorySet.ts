import { parseDocument } from "yaml";
import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleState.js";
import { normalizeRootRef } from "./projectRegistry.js";

export interface RepositorySetEntry {
  url?: string;
  upstream?: string;
  refPrefix?: string;
  fallback: boolean;
  root: boolean;
  rootRef?: string;
  protectedPatterns: string[];
}

export interface RepositorySetUpstream {
  url: string;
}

export interface RepositorySet {
  schemaVersion: 1;
  upstreams: Record<string, RepositorySetUpstream>;
  repositories: Record<string, RepositorySetEntry>;
}

export interface RepositoryRefNamespace {
  prefix?: string;
  fallback?: boolean;
  excludedPrefixes?: string[];
}

export interface ResolvedRepositoryConnection {
  url: string;
  refNamespace?: RepositoryRefNamespace;
}

export function parseRepositorySetYaml(source: string, label = "repos.yml"): RepositorySet {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new UserError(`${label} is invalid YAML: ${document.errors[0]?.message ?? "unknown parse error"}`);
  }
  return normalizeRepositorySet(document.toJS({ maxAliasCount: 0 }), label);
}

export function normalizeRepositorySet(value: unknown, label = "repository set"): RepositorySet {
  const root = object(value, label);
  exactKeys(root, ["schemaVersion", "upstreams", "repositories"], label);
  if (root.schemaVersion !== 1) throw new UserError(`${label}.schemaVersion must be 1`);
  const upstreams = normalizeUpstreams(root.upstreams, label);
  const repositories = object(root.repositories, `${label}.repositories`);
  const normalized: Record<string, RepositorySetEntry> = {};
  for (const [aliasInput, entryValue] of Object.entries(repositories)) {
    const alias = validateLifecycleName(aliasInput, "repo alias");
    const entry = object(entryValue, `${label}.repositories.${alias}`);
    exactKeys(entry, ["url", "upstream", "refPrefix", "fallback", "root", "ref", "protect"], `${label}.repositories.${alias}`);
    const url = optionalGitUrl(entry.url, `${label}.repositories.${alias}.url`);
    const upstream = optionalLifecycleName(entry.upstream, `${label}.repositories.${alias}.upstream`);
    const refPrefix = optionalRefPrefix(entry.refPrefix, `${label}.repositories.${alias}.refPrefix`);
    const fallback = entry.fallback === undefined
      ? false
      : boolean(entry.fallback, `${label}.repositories.${alias}.fallback`);
    const rootFlag = entry.root === undefined ? false : boolean(entry.root, `${label}.repositories.${alias}.root`);
    const ref = optionalString(entry.ref, `${label}.repositories.${alias}.ref`);
    if (ref !== undefined && !rootFlag) {
      throw new UserError(`${label}.repositories.${alias}.ref requires root: true`);
    }
    normalized[alias] = {
      ...(url === undefined ? {} : { url }),
      ...(upstream === undefined ? {} : { upstream }),
      ...(refPrefix === undefined ? {} : { refPrefix }),
      fallback,
      root: rootFlag,
      ...(ref === undefined ? {} : { rootRef: normalizeRootRef(ref) }),
      protectedPatterns: stringArray(entry.protect, `${label}.repositories.${alias}.protect`)
    };
  }
  if (Object.keys(normalized).length === 0) throw new UserError(`${label}.repositories must not be empty`);
  const set = { schemaVersion: 1 as const, upstreams, repositories: normalized };
  validateSharedUpstreams(set, label);
  return set;
}

export function validateRepositorySet(value: unknown, label = "repositorySet"): RepositorySet {
  const root = object(value, label);
  exactKeys(root, ["schemaVersion", "upstreams", "repositories"], label);
  if (root.schemaVersion !== 1) throw new UserError(`${label}.schemaVersion must be 1`);
  const upstreams = validateUpstreams(root.upstreams, label);
  const repositories = object(root.repositories, `${label}.repositories`);
  const normalized: Record<string, RepositorySetEntry> = {};
  for (const [aliasInput, entryValue] of Object.entries(repositories)) {
    const alias = validateLifecycleName(aliasInput, "repo alias");
    const entry = object(entryValue, `${label}.repositories.${alias}`);
    exactKeys(entry, ["url", "upstream", "refPrefix", "fallback", "root", "rootRef", "protectedPatterns"], `${label}.repositories.${alias}`);
    const url = optionalGitUrl(entry.url, `${label}.repositories.${alias}.url`);
    const upstream = optionalLifecycleName(entry.upstream, `${label}.repositories.${alias}.upstream`);
    const refPrefix = optionalRefPrefix(entry.refPrefix, `${label}.repositories.${alias}.refPrefix`);
    const fallback = boolean(entry.fallback, `${label}.repositories.${alias}.fallback`);
    const rootFlag = boolean(entry.root, `${label}.repositories.${alias}.root`);
    const rootRef = optionalString(entry.rootRef, `${label}.repositories.${alias}.rootRef`);
    if (rootRef !== undefined && !rootFlag) {
      throw new UserError(`${label}.repositories.${alias}.rootRef requires root: true`);
    }
    normalized[alias] = {
      ...(url === undefined ? {} : { url }),
      ...(upstream === undefined ? {} : { upstream }),
      ...(refPrefix === undefined ? {} : { refPrefix }),
      fallback,
      root: rootFlag,
      ...(rootRef === undefined ? {} : { rootRef: normalizeRootRef(rootRef) }),
      protectedPatterns: stringArray(
        entry.protectedPatterns,
        `${label}.repositories.${alias}.protectedPatterns`
      )
    };
  }
  if (Object.keys(normalized).length === 0) throw new UserError(`${label}.repositories must not be empty`);
  const set = { schemaVersion: 1 as const, upstreams, repositories: normalized };
  validateSharedUpstreams(set, label);
  return set;
}

export function resolveRepositoryConnection(
  set: RepositorySet,
  alias: string
): ResolvedRepositoryConnection | undefined {
  const entry = set.repositories[alias];
  if (!entry) throw new UserError(`repository set has no repository '${alias}'`);
  if (entry.url !== undefined) return { url: entry.url };
  if (entry.upstream === undefined) return undefined;
  const upstream = set.upstreams[entry.upstream];
  if (!upstream) throw new UserError(`repository '${alias}' references unknown upstream '${entry.upstream}'`);
  if (entry.refPrefix !== undefined) {
    return { url: upstream.url, refNamespace: { prefix: entry.refPrefix } };
  }
  return {
    url: upstream.url,
    refNamespace: {
      fallback: true,
      excludedPrefixes: Object.values(set.repositories)
        .filter((candidate) => candidate.upstream === entry.upstream && candidate.refPrefix !== undefined)
        .map((candidate) => candidate.refPrefix!)
        .sort()
    }
  };
}

export function mapExternalRefToRepository(
  namespace: RepositoryRefNamespace | undefined,
  ref: string
): string | undefined {
  const parsed = splitRef(ref);
  if (!namespace) return ref;
  if (namespace.prefix !== undefined) {
    return parsed.name.startsWith(namespace.prefix)
      ? `${parsed.base}${parsed.name.slice(namespace.prefix.length)}`
      : undefined;
  }
  if (namespace.fallback) {
    return namespace.excludedPrefixes?.some((prefix) => parsed.name.startsWith(prefix)) ? undefined : ref;
  }
  return ref;
}

export function mapRepositoryRefToExternal(
  namespace: RepositoryRefNamespace | undefined,
  ref: string
): string {
  const parsed = splitRef(ref);
  if (!namespace) return ref;
  if (namespace.prefix !== undefined) return `${parsed.base}${namespace.prefix}${parsed.name}`;
  if (namespace.fallback && namespace.excludedPrefixes?.some((prefix) => parsed.name.startsWith(prefix))) {
    throw new UserError(`ref '${ref}' belongs to another repository's prefix`);
  }
  return ref;
}

export function validateRepositoryRefNamespace(
  value: unknown,
  label = "refNamespace"
): RepositoryRefNamespace {
  const namespace = object(value, label);
  exactKeys(namespace, ["prefix", "fallback", "excludedPrefixes"], label);
  const prefix = optionalRefPrefix(namespace.prefix, `${label}.prefix`);
  const fallback = namespace.fallback === undefined ? false : boolean(namespace.fallback, `${label}.fallback`);
  const excludedPrefixes = namespace.excludedPrefixes === undefined
    ? []
    : stringArray(namespace.excludedPrefixes, `${label}.excludedPrefixes`)
        .map((item, index) => optionalRefPrefix(item, `${label}.excludedPrefixes[${index}]`)!);
  if ((prefix === undefined) === !fallback) {
    throw new UserError(`${label} must contain exactly one of prefix or fallback: true`);
  }
  if (prefix !== undefined && excludedPrefixes.length > 0) {
    throw new UserError(`${label}.excludedPrefixes requires fallback: true`);
  }
  return {
    ...(prefix === undefined ? {} : { prefix }),
    ...(fallback ? { fallback: true, excludedPrefixes: excludedPrefixes.sort() } : {})
  };
}

export function assertRepositorySetCanCreateProject(set: RepositorySet, label = "repository set"): void {
  const roots = Object.entries(set.repositories).filter(([, entry]) => entry.root);
  if (roots.length !== 1) throw new UserError(`${label} must contain exactly one repository with root: true`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new UserError(`${label} contains unknown field '${unknown}'`);
}

function normalizeUpstreams(value: unknown, label: string): Record<string, RepositorySetUpstream> {
  if (value === undefined) return {};
  return upstreams(value, label);
}

function validateUpstreams(value: unknown, label: string): Record<string, RepositorySetUpstream> {
  if (value === undefined) return {};
  return upstreams(value, label);
}

function upstreams(value: unknown, label: string): Record<string, RepositorySetUpstream> {
  const entries = object(value, `${label}.upstreams`);
  const result: Record<string, RepositorySetUpstream> = {};
  for (const [nameInput, itemValue] of Object.entries(entries)) {
    const name = validateLifecycleName(nameInput, "upstream name");
    const item = object(itemValue, `${label}.upstreams.${name}`);
    exactKeys(item, ["url"], `${label}.upstreams.${name}`);
    const url = optionalGitUrl(item.url, `${label}.upstreams.${name}.url`);
    if (url === undefined) throw new UserError(`${label}.upstreams.${name}.url is required`);
    result[name] = { url };
  }
  return result;
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
    if ((entry.refPrefix === undefined) === !entry.fallback) {
      throw new UserError(`${entryLabel} must contain exactly one of refPrefix or fallback: true`);
    }
  }
  for (const upstream of Object.keys(set.upstreams)) {
    const members = Object.entries(set.repositories).filter(([, entry]) => entry.upstream === upstream);
    if (members.filter(([, entry]) => entry.fallback).length > 1) {
      throw new UserError(`${label}.upstreams.${upstream} has more than one fallback repository`);
    }
    const prefixes = members.flatMap(([alias, entry]) => entry.refPrefix ? [{ alias, prefix: entry.refPrefix }] : []);
    for (let left = 0; left < prefixes.length; left += 1) {
      for (let right = left + 1; right < prefixes.length; right += 1) {
        const a = prefixes[left]!;
        const b = prefixes[right]!;
        if (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) {
          throw new UserError(`${label} has overlapping ref prefixes for '${a.alias}' and '${b.alias}'`);
        }
      }
    }
  }
}

function optionalLifecycleName(value: unknown, label: string): string | undefined {
  const text = optionalString(value, label);
  return text === undefined ? undefined : validateLifecycleName(text, label);
}

function optionalRefPrefix(value: unknown, label: string): string | undefined {
  const text = optionalString(value, label);
  if (text === undefined) return undefined;
  if (!text.endsWith("/") || text.startsWith("/") || text.includes("//") || text.includes("..") ||
      text.includes("@{") || text.includes("\\") || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(text)) {
    throw new UserError(`${label} must be a safe ref-name prefix ending in '/'`);
  }
  return text;
}

function splitRef(ref: string): { base: "refs/heads/" | "refs/tags/"; name: string } {
  const base = ref.startsWith("refs/heads/") ? "refs/heads/"
    : ref.startsWith("refs/tags/") ? "refs/tags/"
    : undefined;
  if (!base || ref.length === base.length) throw new UserError(`unsupported Git ref '${ref}'`);
  return { base, name: ref.slice(base.length) };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new UserError(`${label} must be a non-empty string`);
  return value;
}

function optionalGitUrl(value: unknown, label: string): string | undefined {
  const text = optionalString(value, label);
  if (text === undefined) return undefined;
  if (/^https?:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw new UserError(`${label} must be a valid HTTP Git URL`);
    }
    if (parsed.username || parsed.password) {
      throw new UserError(`${label} must not contain credentials; use the host Git credential configuration`);
    }
  }
  return text;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new UserError(`${label} must be a boolean`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new UserError(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new UserError(`${label} must not contain duplicates`);
  return value as string[];
}
