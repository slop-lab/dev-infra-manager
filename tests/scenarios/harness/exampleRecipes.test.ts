import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { loadExampleRecipe, resolveExamplePath } from "../../../scripts/examples/recipe.ts";
const examples = resolve(import.meta.dirname, "../../../examples");
it("every catalog example declares exact role plugins and executable owned stages", async () => {
  const catalog: unknown = JSON.parse(await readFile(join(examples, "catalog.json"), "utf8"));
  if (!Array.isArray(catalog) || !catalog.every((value): value is string => typeof value === "string")) throw new Error("invalid catalog");
  const names = new Set<string>();
  for (const relative of catalog) {
    const recipe = await loadExampleRecipe(resolveExamplePath({ directory: examples }, relative));
    expect(names.has(recipe.name)).toBe(false); names.add(recipe.name);
    for (const command of Object.values(recipe.commands)) {
      expect(command.argv[0]).toBe("bash");
      await access(resolveExamplePath(recipe, command.argv[1]!));
    }
    for (const repository of recipe.repositories) {
      await access(resolveExamplePath(recipe, repository.path));
      if (repository.policy) {
        const raw: unknown = JSON.parse(await readFile(resolveExamplePath(recipe, repository.policy), "utf8"));
        expect(raw).toMatchObject({ schemaVersion: 1, repositoryId: repository.id });
      }
    }
  }
  expect(names.size).toBe(catalog.length);
});
it("rejects floating plugin versions, role confusion and paths outside the owning example", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-recipe-schema-"));
  try {
    const source = await readFile(join(examples, "projects/basic-development/recipe.json"), "utf8");
    const recipe: unknown = JSON.parse(source);
    if (!recipe || typeof recipe !== "object") throw new Error("invalid fixture");
    for (const plugins of [
      { host: ["@slop-lab/dim-host-plugin-agent-tools@latest"], controlPlane: [] },
      { host: ["@slop-lab/dim-control-plane-plugin-execution-scheduler@0.10.0"], controlPlane: [] }
    ]) {
      await writeFile(join(directory, "recipe.json"), JSON.stringify({ ...recipe, plugins }));
      await expect(loadExampleRecipe(directory)).rejects.toThrow(/exact role/);
    }
    await writeFile(join(directory, "recipe.json"), JSON.stringify({ ...recipe, repositories: [{ id: "app", path: "../foreign" }] }));
    await expect(loadExampleRecipe(directory)).rejects.toThrow(/escapes/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("installation consumes exact recipe declarations through the selected facade and local bundle", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile), directory = await mkdtemp(join(tmpdir(), "dim-recipe-install-"));
  try {
    const facade = join(directory, "dim"), output = join(directory, "argv");
    await writeFile(facade, '#!/bin/sh\nprintf "%s\\n" "$@" > "$DIM_EXAMPLE_ARGV_OUTPUT"\n', { mode: 0o700 });
    const recipe = join(examples, "projects/native-basic-root"), runner = resolve(examples, "../scripts/examples/run.ts");
    for (const [stage, command] of [["install-host", ["plugin"]], ["install-control-plane", ["control-plane", "plugin"]]] as const) {
      await execute(process.execPath, [runner, recipe, stage], { env: { ...process.env, DIM_EXAMPLE_DIM_BIN: facade,
        DIM_EXAMPLE_ARGV_OUTPUT: output, DIM_EXAMPLE_PACKAGE_BUNDLE: directory } });
      const declared = await loadExampleRecipe(recipe);
      expect((await readFile(output, "utf8")).trim().split("\n")).toEqual(["installer", "install", ...command,
        "--local-packages", directory, ...(stage === "install-host" ? declared.plugins.host : declared.plugins.controlPlane)]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("development refuses to overwrite existing operator repository contents", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const { mkdir } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "dim-example-preserve-"));
  try {
    await mkdir(join(directory, "app")); await writeFile(join(directory, "app/valuable.txt"), "preserve me\n");
    await expect(promisify(execFile)(process.execPath, [resolve(examples, "../scripts/examples/native-dev.ts"),
      join(examples, "projects/basic-development")], { env: { ...process.env, DIM_EXAMPLE_WORK: directory } }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("refusing to overwrite") });
    expect(await readFile(join(directory, "app/valuable.txt"), "utf8")).toBe("preserve me\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("imports a private exclusive policy copy while preserving the checked-in operator input", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const { stat } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "dim-example-private-policy-"));
  try {
    const facade = join(directory, "dim"), output = join(directory, "policy-path");
    await writeFile(facade, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--policy" ]; then printf "%s" "$2" > "$DIM_EXAMPLE_POLICY_OUTPUT"; break; fi\n  shift\ndone\n', { mode: 0o700 });
    const original = join(examples, "projects/native-basic-root/repository-policy.json");
    const before = await readFile(original), permissions = (await stat(original)).mode;
    const work = join(directory, "operator");
    await promisify(execFile)(process.execPath, [resolve(examples, "../scripts/examples/native-dev.ts"),
      join(examples, "projects/native-basic-root")], { env: { ...process.env, DIM_BIN: facade,
      DIM_EXAMPLE_WORK: work, DIM_EXAMPLE_POLICY_OUTPUT: output } });
    const policy = await readFile(output, "utf8");
    expect(policy).toBe(join(work, "policies/root.json"));
    expect((await stat(policy)).mode & 0o777).toBe(0o600);
    expect((await stat(join(work, "policies"))).mode & 0o777).toBe(0o700);
    expect(await readFile(policy)).toEqual(before);
    expect(await readFile(original)).toEqual(before); expect((await stat(original)).mode).toBe(permissions);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
