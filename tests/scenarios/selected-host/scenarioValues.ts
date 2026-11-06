import { OperatorInputError } from "./config.js";

export function json(output: string, label: string): unknown {
  try { return JSON.parse(output); }
  catch (error) { throw new OperatorInputError(`${label} is not JSON`, { cause: error }); }
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OperatorInputError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
export function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new OperatorInputError(`${label} must be an array`);
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OperatorInputError(`${label} must be a non-empty string`);
  return value;
}
export function parsePlugins(output: string): readonly { readonly name: string; readonly state?: string; readonly commands: readonly string[] }[] {
  const parsed = json(output, "plugin discovery");
  const entries = Array.isArray(parsed) ? parsed : record(parsed, "guest plugin discovery")["plugins"];
  return array(entries, "plugin discovery").map((value) => {
    const plugin = record(value, "plugin"), state = plugin["state"];
    if (state !== undefined && typeof state !== "string") throw new OperatorInputError("plugin state must be a string");
    const commands = plugin["commands"] === undefined ? [] : array(plugin["commands"], "plugin commands").map((entry) => text(record(entry, "plugin command")["name"], "plugin command name"));
    return { name: text(plugin["name"], "plugin name"), commands, ...(state === undefined ? {} : { state }) };
  });
}
