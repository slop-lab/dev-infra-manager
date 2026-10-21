import { lstat, readFile, readdir } from "node:fs/promises";
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a DIM state object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error("invalid DIM state string");
  return value;
}
export async function metadata(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function readJson(path: string): Promise<unknown | undefined> {
  const stat = await metadata(path);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 8 * 1024 * 1024) throw new Error(`unsafe state file: ${path}`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export async function jsonFiles(directory: string): Promise<string[]> {
  if (!await metadata(directory)) return [];
  return (await readdir(directory)).filter((name) => name.endsWith(".json")).map((name) => `${directory}/${name}`);
}
export function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result)) throw new Error("invalid DIM ownership UUID");
  return result;
}
