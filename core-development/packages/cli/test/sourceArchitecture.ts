import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliSourceDirectory = fileURLToPath(
  new URL("../../../../core/packages/cli/src", import.meta.url)
);

export async function readCliSource(...modules: string[]): Promise<string> {
  return (await Promise.all(modules.map((module) =>
    readFile(path.join(cliSourceDirectory, `${module}.ts`), "utf8")))).join("\n");
}

export async function cliSourceCycles(): Promise<readonly (readonly string[])[]> {
  const files = (await readdir(cliSourceDirectory))
    .filter((file) => file.endsWith(".ts"));
  const modules = new Set(files.map((file) => file.slice(0, -3)));
  const dependencies = new Map<string, readonly string[]>();
  const importPattern = /(?:import|export)\s+(?:[^;]*?\sfrom\s+)?["']\.\/([^"']+)\.js["'];/g;

  for (const module of modules) {
    const source = await readFile(path.join(cliSourceDirectory, `${module}.ts`), "utf8");
    dependencies.set(module, [...source.matchAll(importPattern)]
      .map((match) => match[1])
      .filter((dependency): dependency is string => dependency !== undefined && modules.has(dependency)));
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const stack: string[] = [];
  const visit = (module: string): void => {
    const cycleStart = active.get(module);
    if (cycleStart !== undefined) {
      cycles.push([...stack.slice(cycleStart), module]);
      return;
    }
    if (visited.has(module)) return;
    active.set(module, stack.length);
    stack.push(module);
    for (const dependency of dependencies.get(module) ?? []) visit(dependency);
    stack.pop();
    active.delete(module);
    visited.add(module);
  };
  for (const module of modules) visit(module);
  return cycles;
}
