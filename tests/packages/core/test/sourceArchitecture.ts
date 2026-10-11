import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

function hasRuntimeImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  return clause.namedBindings === undefined
    || !ts.isNamedImports(clause.namedBindings)
    || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function hasRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  return node.exportClause === undefined
    || !ts.isNamedExports(node.exportClause)
    || node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function relativeRuntimeSpecifiers(source: string, fileName: string): readonly string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  for (const node of sourceFile.statements) {
    if (ts.isImportDeclaration(node) && hasRuntimeImport(node)
      && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".")) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && hasRuntimeExport(node)
      && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith(".")) {
      specifiers.push(node.moduleSpecifier.text);
    }
  }
  return specifiers;
}

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files;
}

function sourceTarget(importer: string, specifier: string): string {
  const resolved = path.resolve(path.dirname(importer), specifier);
  if (resolved.endsWith(".js")) return `${resolved.slice(0, -3)}.ts`;
  if (resolved.endsWith(".mjs")) return `${resolved.slice(0, -4)}.mts`;
  if (resolved.endsWith(".cjs")) return `${resolved.slice(0, -4)}.cts`;
  return resolved;
}

export async function runtimeSourceSccs(directory: string): Promise<readonly (readonly string[])[]> {
  const files = await sourceFiles(directory);
  const sourceFileSet = new Set(files);
  const dependencies = new Map<string, readonly string[]>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    dependencies.set(file, relativeRuntimeSpecifiers(source, file)
      .map((specifier) => sourceTarget(file, specifier))
      .filter((target) => sourceFileSet.has(target)));
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  const visit = (file: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indices.set(file, index);
    lowLinks.set(file, index);
    stack.push(file);
    stacked.add(file);
    for (const dependency of dependencies.get(file) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(file, Math.min(lowLinks.get(file) ?? index, lowLinks.get(dependency) ?? index));
      } else if (stacked.has(dependency)) {
        lowLinks.set(file, Math.min(lowLinks.get(file) ?? index, indices.get(dependency) ?? index));
      }
    }
    if (lowLinks.get(file) !== indices.get(file)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member !== undefined) {
        stacked.delete(member);
        component.push(path.relative(directory, member).split(path.sep).join("/"));
      }
    } while (member !== file);
    if (component.length > 1) components.push(component.sort());
  };
  for (const file of files) {
    if (!indices.has(file)) visit(file);
  }
  return components.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}
