import { parseDocument } from "yaml";
import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleState.js";
import { normalizeRootRef } from "./projectRegistry.js";

export interface RepositorySetEntry {
  url?: string;
  root: boolean;
  rootRef?: string;
  protectedPatterns: string[];
}

export interface RepositorySet {
  schemaVersion: 1;
  repositories: Record<string, RepositorySetEntry>;
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
  exactKeys(root, ["schemaVersion", "repositories"], label);
  if (root.schemaVersion !== 1) throw new UserError(`${label}.schemaVersion must be 1`);
  const repositories = object(root.repositories, `${label}.repositories`);
  const normalized: Record<string, RepositorySetEntry> = {};
  for (const [aliasInput, entryValue] of Object.entries(repositories)) {
    const alias = validateLifecycleName(aliasInput, "repo alias");
    const entry = object(entryValue, `${label}.repositories.${alias}`);
    exactKeys(entry, ["url", "root", "ref", "protect"], `${label}.repositories.${alias}`);
    const url = optionalGitUrl(entry.url, `${label}.repositories.${alias}.url`);
    const rootFlag = entry.root === undefined ? false : boolean(entry.root, `${label}.repositories.${alias}.root`);
    const ref = optionalString(entry.ref, `${label}.repositories.${alias}.ref`);
    if (ref !== undefined && !rootFlag) {
      throw new UserError(`${label}.repositories.${alias}.ref requires root: true`);
    }
    normalized[alias] = {
      ...(url === undefined ? {} : { url }),
      root: rootFlag,
      ...(ref === undefined ? {} : { rootRef: normalizeRootRef(ref) }),
      protectedPatterns: stringArray(entry.protect, `${label}.repositories.${alias}.protect`)
    };
  }
  if (Object.keys(normalized).length === 0) throw new UserError(`${label}.repositories must not be empty`);
  return { schemaVersion: 1, repositories: normalized };
}

export function validateRepositorySet(value: unknown, label = "repositorySet"): RepositorySet {
  const root = object(value, label);
  exactKeys(root, ["schemaVersion", "repositories"], label);
  if (root.schemaVersion !== 1) throw new UserError(`${label}.schemaVersion must be 1`);
  const repositories = object(root.repositories, `${label}.repositories`);
  const normalized: Record<string, RepositorySetEntry> = {};
  for (const [aliasInput, entryValue] of Object.entries(repositories)) {
    const alias = validateLifecycleName(aliasInput, "repo alias");
    const entry = object(entryValue, `${label}.repositories.${alias}`);
    exactKeys(entry, ["url", "root", "rootRef", "protectedPatterns"], `${label}.repositories.${alias}`);
    const url = optionalGitUrl(entry.url, `${label}.repositories.${alias}.url`);
    const rootFlag = boolean(entry.root, `${label}.repositories.${alias}.root`);
    const rootRef = optionalString(entry.rootRef, `${label}.repositories.${alias}.rootRef`);
    if (rootRef !== undefined && !rootFlag) {
      throw new UserError(`${label}.repositories.${alias}.rootRef requires root: true`);
    }
    normalized[alias] = {
      ...(url === undefined ? {} : { url }),
      root: rootFlag,
      ...(rootRef === undefined ? {} : { rootRef: normalizeRootRef(rootRef) }),
      protectedPatterns: stringArray(
        entry.protectedPatterns,
        `${label}.repositories.${alias}.protectedPatterns`
      )
    };
  }
  if (Object.keys(normalized).length === 0) throw new UserError(`${label}.repositories must not be empty`);
  return { schemaVersion: 1, repositories: normalized };
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
