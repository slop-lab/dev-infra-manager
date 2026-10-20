import { execFileSync } from "node:child_process";
import { mkdir, cp, access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadExampleRecipe, resolveExamplePath } from "./recipe.ts";
const recipe = await loadExampleRecipe(process.argv[2] ?? ".");
const work = process.env.DIM_EXAMPLE_WORK;
if (!work || !work.startsWith("/")) throw new Error("set DIM_EXAMPLE_WORK to an absolute disposable operator directory");
const dim = process.env.DIM_BIN ?? "dim", project = process.env.DIM_EXAMPLE_PROJECT ?? recipe.name;
const workspace = process.env.DIM_EXAMPLE_WORKSPACE ?? `${recipe.name}-dev`;
const image = process.env.DIM_EXAMPLE_WORKSPACE_IMAGE;
const imageArguments = image === undefined ? [] : ["--image", image];
const run = (program: string, argv: string[], cwd?: string) => execFileSync(program, argv, { ...(cwd === undefined ? {} : { cwd }), stdio: "inherit" });
await mkdir(work, { recursive: true });
for (const repository of recipe.repositories) {
  const destination = join(resolve(work), repository.id);
  try { await access(destination); throw new Error(`refusing to overwrite existing example source: ${destination}`); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  await cp(resolveExamplePath(recipe, repository.path), destination, { recursive: true });
  run("git", ["init", "--initial-branch=main", destination]);
  run("git", ["add", "."], destination);
  run("git", ["-c", "user.name=DIM Example", "-c", "user.email=example@invalid", "commit", "-m", "example source"], destination);
}
if (recipe.repositories.some(({ policy }) => policy !== undefined)) {
  const policyDirectory = join(resolve(work), "policies");
  await mkdir(policyDirectory, { mode: 0o700 });
  const policies = new Map<string, string>();
  for (const repository of recipe.repositories) {
    if (!repository.policy) throw new Error("native example repository needs a reviewed policy");
    const policy = join(policyDirectory, `${repository.id}.json`);
    await writeFile(policy, await readFile(resolveExamplePath(recipe, repository.policy)), { flag: "wx", mode: 0o600 });
    policies.set(repository.id, policy);
  }
  run(dim, ["project", "create", project, "--project-id", project]);
  for (const repository of recipe.repositories) {
    const policy = policies.get(repository.id);
    if (!policy) throw new Error("private example policy is missing");
    run(dim, ["project", "repository", "import", project, repository.id, "--source", join(work, repository.id), "--ref", "refs/heads/main", "--policy", policy]);
  }
  const working = recipe.repositories.at(-1); if (!working) throw new Error("example has no repository");
  run(dim, ["project", "configure", project, "--configuration-repository", working.id, "--default-repository", working.id]);
  run(dim, ["create", `dim://${project}`, workspace, ...imageArguments, ...recipe.repositories.flatMap(({ id }) => ["--repository", id]), "--workdir", working.id]);
} else {
  const source = recipe.repositories[0]; if (!source) throw new Error("example has no ordinary source repository");
  run(dim, ["create", join(work, source.id), workspace, ...imageArguments]);
}
console.log(`Workspace ${workspace} is ready. Discard it explicitly when finished; operator sources remain at ${work}.`);
