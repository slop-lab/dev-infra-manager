import { UserError } from "./errors.js";
import { boolean, branchMap, exactKeys, object, optionalRefPrefix, stringArray } from "./repositorySetFields.js";
import type {
  RepositoryRefNamespace,
  RepositorySet,
  ResolvedRepositoryConnection
} from "./repositorySetTypes.js";

export function resolveRepositoryConnection(
  set: RepositorySet,
  alias: string
): ResolvedRepositoryConnection | undefined {
  const entry = set.repositories[alias];
  if (!entry) throw new UserError(`repository set has no repository '${alias}'`);
  const publish = Object.keys(entry.publishBranches).length === 0 ? {} : { publishBranches: entry.publishBranches };
  const imported = Object.keys(entry.importBranches).length === 0
    ? {}
    : { refNamespace: { branches: entry.importBranches } };
  if (entry.url !== undefined) return { url: entry.url, ...imported, ...publish };
  if (entry.upstream === undefined) return undefined;
  const upstream = set.upstreams[entry.upstream];
  if (!upstream) throw new UserError(`repository '${alias}' references unknown upstream '${entry.upstream}'`);
  if (Object.keys(entry.importBranches).length > 0) {
    return { url: upstream.url, refNamespace: { branches: entry.importBranches }, ...publish };
  }
  if (entry.refPrefix !== undefined) {
    return { url: upstream.url, refNamespace: { prefix: entry.refPrefix }, ...publish };
  }
  return {
    url: upstream.url,
    refNamespace: {
      fallback: true,
      excludedPrefixes: Object.values(set.repositories)
        .flatMap((candidate) => {
          if (candidate.upstream !== entry.upstream || candidate.refPrefix === undefined) return [];
          return [candidate.refPrefix];
        })
        .sort()
    },
    ...publish
  };
}

export function mapExternalRefToRepository(
  namespace: RepositoryRefNamespace | undefined,
  ref: string
): string | undefined {
  const parsed = splitRef(ref);
  if (!namespace) return ref;
  if (namespace.branches !== undefined) {
    if (parsed.base !== "refs/heads/") return undefined;
    const mapped = Object.entries(namespace.branches)
      .find(([, external]) => external === parsed.name)?.[0];
    return mapped === undefined ? undefined : `refs/heads/${mapped}`;
  }
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
  if (namespace.branches !== undefined) {
    if (parsed.base !== "refs/heads/" || namespace.branches[parsed.name] === undefined) {
      throw new UserError(`ref '${ref}' is not in the reviewed import branch mapping`);
    }
    return `refs/heads/${namespace.branches[parsed.name]}`;
  }
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
  exactKeys(namespace, ["prefix", "fallback", "excludedPrefixes", "branches"], label);
  const prefix = optionalRefPrefix(namespace.prefix, `${label}.prefix`);
  const fallback = namespace.fallback === undefined ? false : boolean(namespace.fallback, `${label}.fallback`);
  const excludedPrefixes = namespace.excludedPrefixes === undefined
    ? []
    : stringArray(namespace.excludedPrefixes, `${label}.excludedPrefixes`)
        .flatMap((item, index) => {
          const prefix = optionalRefPrefix(item, `${label}.excludedPrefixes[${index}]`);
          return prefix === undefined ? [] : [prefix];
        });
  const branches = branchMap(namespace.branches, `${label}.branches`, "import");
  const hasBranches = Object.keys(branches).length > 0;
  if ([prefix !== undefined, fallback, hasBranches].filter(Boolean).length !== 1) {
    throw new UserError(`${label} must contain exactly one of prefix, fallback: true, or branches`);
  }
  if (!fallback && excludedPrefixes.length > 0) {
    throw new UserError(`${label}.excludedPrefixes requires fallback: true`);
  }
  return {
    ...(prefix === undefined ? {} : { prefix }),
    ...(fallback ? { fallback: true, excludedPrefixes: excludedPrefixes.sort() } : {}),
    ...(hasBranches ? { branches } : {})
  };
}

function splitRef(ref: string): { base: "refs/heads/" | "refs/tags/"; name: string } {
  const base = ref.startsWith("refs/heads/") ? "refs/heads/"
    : ref.startsWith("refs/tags/") ? "refs/tags/"
    : undefined;
  if (!base || ref.length === base.length) throw new UserError(`unsupported Git ref '${ref}'`);
  return { base, name: ref.slice(base.length) };
}
