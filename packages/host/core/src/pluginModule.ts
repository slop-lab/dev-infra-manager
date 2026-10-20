import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";

/** Resolve an operator-selected host module. Named packages must be installed in this runtime tree. */
export async function resolveHostPluginModule(home: string, specifier: string): Promise<string> {
  // Immutable release paths also separate Node resolution caches across current-symlink updates.
  const selectedHome = await realpath(path.resolve(home));
  const resolver = createRequire(path.join(selectedHome, "package.json"));
  // Explicit development paths select their module directly rather than a package lookup.
  if (specifier.startsWith("file:")) return realpath(fileURLToPath(specifier));
  if (path.isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../")) {
    return realpath(resolver.resolve(specifier));
  }
  const parts = specifier.split("/");
  const scoped = specifier.startsWith("@");
  const names = parts.slice(0, scoped ? 2 : 1);
  if (names.length !== (scoped ? 2 : 1) || names.some((name, index) =>
    !/^[a-z0-9_-][a-z0-9._-]*$/i.test(scoped && index === 0 ? name.slice(1) : name))) {
    throw new UserError(`invalid host plugin package specifier '${specifier}'`);
  }
  const packageName = names.join("/");
  let selectedPackage: string;
  try { selectedPackage = await realpath(path.join(selectedHome, "node_modules", packageName)); }
  catch (error) { throw new UserError(`host plugin '${packageName}' is not installed in ${selectedHome}`, { cause: error }); }
  const entry = await realpath(resolver.resolve(specifier));
  const relative = path.relative(selectedPackage, entry);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UserError(`host plugin '${specifier}' resolves outside its installed package`);
  }
  return entry;
}
