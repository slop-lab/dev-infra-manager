import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Pin the reviewed local graph; true means npm must install this manifest without archive arguments. */
export async function prepareLocalNpmGraph(directory: string, names: readonly string[] | undefined,
  specifiers: readonly string[]): Promise<boolean> {
  if (names === undefined || !specifiers.some(specifier => specifier.endsWith(".tgz"))) return false;
  if (names.length !== specifiers.length || new Set(names).size !== names.length
    || names.some(name => !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    || specifiers.some(specifier => !specifier.endsWith(".tgz"))) throw new Error("local package names must match the complete artifact closure");
  const file = path.join(directory, "package.json");
  const value = await packageJson(file);
  const dependencies = { ...object(value.dependencies ?? {}) };
  const overrides = { ...object(value.overrides ?? {}) };
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!, specifier = specifiers[index]!;
    dependencies[name] = `file:${path.resolve(specifier.startsWith("file:") ? specifier.slice(5) : specifier)}`;
    // A reference follows npm's relative-path normalization and subsequent local upgrades.
    overrides[name] = `$${name}`;
  }
  await writeFile(file, JSON.stringify({ ...value, private: true, dependencies, overrides }, null, 2) + "\n", { mode: 0o600 });
  return true;
}

export async function removeLocalNpmOverrides(directory: string, names: readonly string[]): Promise<void> {
  const file = path.join(directory, "package.json"), value = await packageJson(file);
  const overrides = { ...object(value.overrides ?? {}) };
  let changed = false;
  for (const name of names) if (overrides[name] === `$${name}`) { delete overrides[name]; changed = true; }
  if (changed) await writeFile(file, JSON.stringify({ ...value, overrides }, null, 2) + "\n", { mode: 0o600 });
}
async function packageJson(file: string): Promise<Record<string, unknown>> {
  try { return object(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) { if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return {}; throw error; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid local npm runtime manifest");
  return Object.fromEntries(Object.entries(value));
}
