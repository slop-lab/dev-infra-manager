import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";

async function optional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
}
async function atomic(file: string, contents: string, mode = 0o644): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export function clientConfiguration(endpoint: string) {
  return { files: [{ target: "/etc/apt/apt.conf.d/99dim-mirrors", contents: `Acquire::http::Proxy "${endpoint}";\nAcquire::https::Proxy "DIRECT";\n` }] };
}
export async function configureSystem(endpoint: string): Promise<void> {
  await mkdir("/etc/apt/apt.conf.d", { recursive: true });
  for (const file of clientConfiguration(endpoint).files) if (await optional(file.target) !== file.contents) await atomic(file.target, file.contents);
}
export async function removeExactConfiguration(file: string, contents: string): Promise<void> {
  if (await optional(file) === contents) await rm(file);
}
export async function removeSystem(endpoint: string): Promise<void> {
  for (const file of clientConfiguration(endpoint).files) await removeExactConfiguration(file.target, file.contents);
}
export function retiredClientConfiguration() { return { files: [{ target: "/etc/apt/apt.conf.d/99dim-mirrors", contents: 'Acquire::http::Proxy "DIRECT";\nAcquire::https::Proxy "DIRECT";\n' }] }; }
