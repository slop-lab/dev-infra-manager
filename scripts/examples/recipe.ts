import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

export type ExampleCommand = { readonly argv: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string>> };
export type ExampleRecipe = {
  readonly directory: string;
  readonly schemaVersion: 1;
  readonly name: string;
  readonly plugins: { readonly host: readonly string[]; readonly controlPlane: readonly string[] };
  readonly repositories: readonly { readonly id: string; readonly path: string; readonly policy?: string }[];
  readonly commands: Readonly<Record<string, ExampleCommand>>;
};
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected recipe object");
  return Object.fromEntries(Object.entries(value));
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown recipe field");
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || value.includes("\0")) throw new Error("invalid recipe string");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("invalid recipe list");
  return value.map(text);
}
export function resolveExamplePath(recipe: Pick<ExampleRecipe, "directory">, value: string): string {
  if (isAbsolute(value)) throw new Error("recipe paths must be relative");
  const path = resolve(recipe.directory, value), offset = relative(recipe.directory, path);
  if (offset === ".." || offset.startsWith("../")) throw new Error("recipe path escapes example directory");
  return path;
}
export async function loadExampleRecipe(directory: string): Promise<ExampleRecipe> {
  const base = resolve(directory), bytes = await readFile(resolve(base, "recipe.json"));
  if (bytes.length > 65536) throw new Error("recipe is too large");
  const raw = object(JSON.parse(bytes.toString("utf8"))); keys(raw, ["schemaVersion", "name", "plugins", "repositories", "commands"]);
  if (raw.schemaVersion !== 1) throw new Error("unsupported example recipe");
  const name = text(raw.name);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("invalid recipe name");
  const plugins = object(raw.plugins); keys(plugins, ["host", "controlPlane"]);
  const host = strings(plugins.host), controlPlane = strings(plugins.controlPlane);
  for (const [role, specs] of [["host", host], ["control-plane", controlPlane]] as const) {
    if (new Set(specs).size !== specs.length || specs.some((spec) => !new RegExp(`^@slop-lab/dim-${role}-plugin-[a-z0-9-]+@0\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$`).test(spec))) throw new Error("example requires exact role-specific plugin versions");
  }
  if (!Array.isArray(raw.repositories) || raw.repositories.length > 64) throw new Error("invalid recipe repositories");
  const repositories = raw.repositories.map((value: unknown) => {
    const repository = object(value); keys(repository, ["id", "path", "policy"]);
    const id = text(repository.id), path = text(repository.path);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("invalid example repository ID");
    resolveExamplePath({ directory: base }, path);
    if (repository.policy === undefined) return { id, path };
    const policy = text(repository.policy); resolveExamplePath({ directory: base }, policy); return { id, path, policy };
  });
  if (new Set(repositories.map(({ id }) => id)).size !== repositories.length) throw new Error("duplicate example repository");
  const commands: Record<string, ExampleCommand> = {};
  for (const [name, value] of Object.entries(object(raw.commands))) {
    if (!["dev", "verify", "verify-vm"].includes(name)) throw new Error("unknown example command");
    const command = object(value); keys(command, ["argv", "cwd", "env"]);
    const argv = strings(command.argv); if (argv.length === 0) throw new Error("empty example command");
    const cwd = command.cwd === undefined ? undefined : text(command.cwd);
    if (cwd !== undefined) resolveExamplePath({ directory: base }, cwd);
    const env = command.env === undefined ? undefined : Object.fromEntries(Object.entries(object(command.env)).map(([key, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || ["PATH", "HOME", "NODE_OPTIONS"].includes(key)) throw new Error("invalid example environment key"); return [key, text(value)];
    }));
    commands[name] = { argv, ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }) };
  }
  if (!commands.dev || !commands.verify) throw new Error("example needs dev and verify commands");
  return { directory: base, schemaVersion: 1, name, plugins: { host, controlPlane }, repositories, commands };
}
