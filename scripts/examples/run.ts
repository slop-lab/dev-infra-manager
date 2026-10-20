import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExampleRecipe, resolveExamplePath, type ExampleCommand, type ExampleRecipe } from "./recipe.ts";
const examples = fileURLToPath(new URL("../../examples/", import.meta.url));
const [directory, stage, ...extra] = process.argv.slice(2);
if (!directory || !stage || extra.length) throw new Error("usage: node scripts/examples/run.ts EXAMPLE_DIRECTORY|all install-host|install-control-plane|dev|verify|verify-vm");
if (!["install-host", "install-control-plane", "dev", "verify", "verify-vm"].includes(stage)) throw new Error("unknown example stage");
async function run(recipe: ExampleRecipe, inherited: NodeJS.ProcessEnv) {
  const environment: NodeJS.ProcessEnv = { ...inherited, ...(inherited.DIM_EXAMPLE_DIM_BIN === undefined ? {} : { DIM_BIN: inherited.DIM_EXAMPLE_DIM_BIN }) };
  const plugins = stage === "install-host" ? recipe.plugins.host : stage === "install-control-plane" ? recipe.plugins.controlPlane : undefined;
  if (plugins?.length === 0) { console.log(`${recipe.name}: no ${stage} plugins`); return; }
  const bundle = environment.DIM_EXAMPLE_PACKAGE_BUNDLE;
  const command: ExampleCommand | undefined = plugins === undefined ? recipe.commands[stage!] : {
    argv: [environment.DIM_BIN ?? "dim", "installer", "install", ...(stage === "install-host" ? ["plugin"] : ["control-plane", "plugin"]),
      ...(bundle === undefined ? [] : ["--local-packages", resolve(bundle)]), ...plugins]
  };
  if (!command) { if (directory === "all") { console.log(`${recipe.name}: no ${stage} stage`); return; } throw new Error(`example has no '${stage}' stage`); }
  const [executable, ...argv] = command.argv; if (!executable) throw new Error("example command is empty");
  console.log(`${recipe.name}: ${stage}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, argv, { cwd: resolveExamplePath(recipe, command.cwd ?? "."), env: { ...environment, ...command.env }, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
    const done = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    child.once("error", (error) => { done(); reject(error); });
    child.once("exit", (code, signal) => { done(); if (code === 0) resolve(); else reject(new Error(`${recipe.name} ${stage} failed (${code ?? signal})`)); });
  });
}
if (directory === "all") {
  const paths: unknown = JSON.parse(await readFile(join(examples, "catalog.json"), "utf8"));
  if (!Array.isArray(paths) || !paths.every((value): value is string => typeof value === "string")) throw new Error("invalid example catalog");
  for (const path of paths) {
    const recipe = await loadExampleRecipe(resolveExamplePath({ directory: examples }, path));
    await run(recipe, { ...process.env, ...(process.env.DIM_EXAMPLE_WORK === undefined ? {} : { DIM_EXAMPLE_WORK: join(process.env.DIM_EXAMPLE_WORK, recipe.name) }) });
  }
} else await run(await loadExampleRecipe(directory), process.env);
