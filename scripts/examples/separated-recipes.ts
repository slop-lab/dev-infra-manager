import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadExampleRecipe, resolveExamplePath } from "./recipe.ts";

/** The disposable composition selects exactly the packages declared by VM recipes. */
export async function separatedControlPlanePackages(examples: string): Promise<ReadonlySet<string>> {
  const catalog: unknown = JSON.parse(await readFile(join(examples, "catalog.json"), "utf8"));
  if (!Array.isArray(catalog) || !catalog.every((entry): entry is string => typeof entry === "string")) throw new Error("invalid example catalog");
  const recipes = await Promise.all(catalog.map((path) => loadExampleRecipe(resolveExamplePath({ directory: examples }, path))));
  return new Set(recipes.filter(({ commands }) => commands["verify-vm"]).flatMap(({ plugins }) => plugins.controlPlane.map((spec) => spec.slice(0, spec.lastIndexOf("@")))));
}
