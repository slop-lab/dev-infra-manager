import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const containerSmoke = resolve(
  repositoryRoot,
  "verification/scripts/container-multi-repo-project-smoke.bash"
);
const materializationSmoke = resolve(
  repositoryRoot,
  "verification/scripts/two-repository-materialization-smoke.bash"
);
const projectMaterializer = resolve(
  repositoryRoot,
  ".dim/reconcile-repositories.sh"
);
const exampleMaterializer = resolve(
  repositoryRoot,
  "examples/projects/two-repository/repos/root/.dim/materialize-app.sh"
);

describe("Project-owned repository materialization policy", () => {
  it.each([
    containerSmoke,
    materializationSmoke,
    projectMaterializer,
    exampleMaterializer,
  ])("keeps %s valid shell", (script) => {
    const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });

    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("executes the real two-repository materialization journey", () => {
    const journey = spawnSync("bash", [materializationSmoke], {
      encoding: "utf8",
    });

    expect(journey.status, journey.stderr).toBe(0);
    expect(journey.stdout).toContain("two-repository-materialization-smoke-ok");
  });

  it("keeps repository policy and mutable destinations in Project code", async () => {
    const source = await readFile(projectMaterializer, "utf8");

    expect(source).toContain('policy="$DIM_PROJECT_ROOT/.dim/workspace-repositories.json"');
    expect(source).toContain('destination="$DIM_WORKSPACE_DATA/$relative_path"');
    expect(source).toContain('test -d "$destination/.git" && exit 0');
    expect(source).toContain('git_base_url="$');
    expect(source).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(source).not.toContain("repositorySnapshot");
    expect(source).not.toContain("repositoryRefOverrides");
    expect(source).not.toContain("--repo-ref");
  });

  it("keeps the container journey delegated to the real materialization smoke", async () => {
    const source = await readFile(containerSmoke, "utf8");

    expect(source).toContain('bash "$script_dir/two-repository-materialization-smoke.bash"');
    expect(source).not.toContain("workspace create");
    expect(source).not.toContain("workspace align");
  });
});