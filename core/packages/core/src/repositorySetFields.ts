import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleState.js";
import type { RepositorySetUpstream } from "./repositorySetTypes.js";

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new UserError(`${label} contains unknown field '${unknown}'`);
}

export function upstreams(value: unknown, label: string): Record<string, RepositorySetUpstream> {
  if (value === undefined) return {};
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

export function optionalLifecycleName(value: unknown, label: string): string | undefined {
  const text = optionalString(value, label);
  return text === undefined ? undefined : validateLifecycleName(text, label);
}

export function optionalRefPrefix(value: unknown, label: string): string | undefined {
  const text = optionalString(value, label);
  if (text === undefined) return undefined;
  if (!text.endsWith("/") || text.startsWith("/") || text.includes("//") || text.includes("..") ||
      text.includes("@{") || text.includes("\\") || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(text)) {
    throw new UserError(`${label} must be a safe ref-name prefix ending in '/'`);
  }
  return text;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new UserError(`${label} must be a non-empty string`);
  return value;
}

export function optionalGitUrl(value: unknown, label: string): string | undefined {
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

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new UserError(`${label} must be a boolean`);
  return value;
}

export function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new UserError(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new UserError(`${label} must not contain duplicates`);
  return value as string[];
}

export function branchMap(value: unknown, label: string, verb = "publish"): Record<string, string> {
  if (value === undefined) return {};
  const entries = object(value, label);
  const result: Record<string, string> = {};
  for (const [source, destinationValue] of Object.entries(entries)) {
    const destination = optionalString(destinationValue, `${label}.${source}`);
    if (destination === undefined) throw new UserError(`${label}.${source} must be a non-empty string`);
    for (const [branch, branchLabel] of [[source, `${label} key`], [destination, `${label}.${source}`]] as const) {
      if (branch.startsWith("refs/")
        || !/^(?!\/|.*(?:\.\.|@\{|\\|\/\/))[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
        || branch.endsWith("/") || branch.endsWith(".")
        || branch.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))) {
        throw new UserError(`${branchLabel} must be a safe branch name without refs/heads/`);
      }
    }
    if (["__proto__", "constructor", "prototype"].includes(source)) {
      throw new UserError(`${label} contains unsupported branch name '${source}'`);
    }
    if (Object.values(result).includes(destination)) {
      throw new UserError(`${label} must not ${verb} multiple branches to '${destination}'`);
    }
    result[source] = destination;
  }
  return result;
}
