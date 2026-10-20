import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
async function optional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
}
async function atomic(file: string, contents: string, mode = 0o644): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export function mergePipIndex(contents: string, index: string): string {
  const base = contents.replace(/^# BEGIN DIM CACHE\r?\n[\s\S]*?^# END DIM CACHE(?:\r?\n|$)/gm, "");
  const global = /^\[global\][ \t]*\r?$/im.exec(base);
  const block = `# BEGIN DIM CACHE\nindex-url = ${index}/\n${new URL(index).protocol === "http:" ? `trusted-host = ${new URL(index).hostname}\n` : ""}# END DIM CACHE\n`;
  if (!global) return `${base}${base && !base.endsWith("\n") ? "\n" : ""}[global]\n${block}`;
  const start = global.index + global[0].length, next = /^\[/m.exec(base.slice(start));
  const section = base.slice(start, next === null ? undefined : start + next.index);
  // An explicit global index or trust policy is an intentional operator override.
  if (/^\s*(?:index-url|trusted-host)\s*=/im.test(section)) return base;
  return `${base.slice(0, start)}\n${block}${base.slice(start).replace(/^\n/, "")}`;
}
export function clientConfiguration(endpoint: string) {
  const url = new URL(endpoint);
  return { files: [{ target: "/etc/pip.conf", contents: `[global]\nindex-url = ${endpoint.replace(/\/$/, "")}/\n${url.protocol === "http:" ? `trusted-host = ${url.hostname}\n` : ""}` }] };
}
export async function configureSystem(endpoint: string): Promise<void> {
  const file = "/etc/pip.conf", previous = await optional(file) ?? "";
  const next = mergePipIndex(previous, endpoint.replace(/\/$/, ""));
  if (previous !== next) await atomic(file, next);
}
export function removePipIndex(contents: string, endpoint: string): string {
  const index = endpoint.replace(/\/$/, "");
  const block = `# BEGIN DIM CACHE\nindex-url = ${index}/\n${new URL(index).protocol === "http:" ? `trusted-host = ${new URL(index).hostname}\n` : ""}# END DIM CACHE\n`;
  return contents.replace(block, "");
}
export async function removeSystem(endpoint: string): Promise<void> {
  const file = "/etc/pip.conf", before = await optional(file);
  if (before === undefined) return;
  const next = removePipIndex(before, endpoint);
  if (next !== before) await atomic(file, next);
}
export function retiredClientConfiguration() { return { files: [{ target: "/etc/pip.conf", contents: "" }] }; }
