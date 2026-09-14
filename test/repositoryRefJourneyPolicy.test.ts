import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const smoke = resolve(
  import.meta.dirname,
  "../scripts/container-multi-repo-project-smoke.bash"
);

describe("multi-repository candidate ref journey policy", () => {
  it("keeps the container smoke valid Bash", () => {
    const command = ["-n", smoke];

    const syntax = spawnSync("bash", command, { encoding: "utf8" });

    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("creates through the CLI with repeated distinct overrides and checks both snapshots", async () => {
    const source = await readFile(smoke, "utf8");

    const creation = source.slice(
      source.indexOf('if ! "$dim_bin" workspace create'),
      source.indexOf('echo "[multi-repository] moved candidate ref')
    );

    expect(creation).toContain('--repo-ref "$api_repo=$candidate_ref"');
    expect(creation).toContain('--repo-ref "$worker_repo=$worker_candidate_ref"');
    expect(creation).toContain('workspace_json="$("$dim_bin" workspace show');
    expect(creation).toContain(".repositorySnapshot.api.requestedRef == $ref");
    expect(creation).toContain(".repositorySnapshot.api.ref == $ref");
    expect(creation).toContain(".repositorySnapshot.api.commit == $commit");
    expect(creation).toContain(".repositorySnapshot.worker.requestedRef == $worker_ref");
    expect(creation).toContain(".repositorySnapshot.worker.commit == $worker_commit");
    expect(creation).toContain(".repositories.api.requestedRef == $ref");
    expect(creation).toContain(".repositories.worker.requestedRef == $worker_ref");
    expect(creation).toContain("/run/dim/project.json");
  });

  it("moves the candidate before setup recovery and retains the recorded commit", async () => {
    const source = await readFile(smoke, "utf8");

    const movement = source.indexOf("moved_candidate_commit=");
    const failedSetup = source.indexOf('workspace setup "$workspace_name"', movement);
    const retainedCommit = source.indexOf(".repositorySnapshot.api.commit", failedSetup);
    const recoveredSetup = source.indexOf('workspace setup "$workspace_name"', failedSetup + 1);
    const runtimeCommit = source.indexOf(".repositories.api.commit /run/dim/project.json", recoveredSetup);

    expect(movement).toBeGreaterThan(0);
    expect(failedSetup).toBeGreaterThan(movement);
    expect(retainedCommit).toBeGreaterThan(failedSetup);
    expect(recoveredSetup).toBeGreaterThan(retainedCommit);
    expect(runtimeCommit).toBeGreaterThan(recoveredSetup);
  });

  it("guards every rejected override with unchanged project, workspace, repository, and ref state", async () => {
    const source = await readFile(smoke, "utf8");

    const rejectionHelper = source.slice(
      source.indexOf("assert_workspace_create_rejected()"),
      source.indexOf("create_repo()")
    );

    expect(rejectionHelper).toContain('project show "$project_name" --json');
    expect(rejectionHelper).toContain('workspace list --json');
    expect(rejectionHelper).toContain('workspace show "$workspace_name" --json');
    expect(rejectionHelper).toContain('repo list "$project_name" --json');
    expect(rejectionHelper).toContain("managed_repository_refs");
    expect(rejectionHelper).toContain('test "$(managed_repository_refs)" = "$refs_before"');

    expect(source).toContain('--repo-ref "atlas=$candidate_ref"');
    expect(source).toContain('--repo-ref "unknown=$candidate_ref"');
    expect(source).toContain("--repo-ref malformed");
    expect(source).toContain('--repo-ref "$api_repo=$candidate_ref" --repo-ref "$api_repo=refs/heads/main"');
    expect(source).toContain('--repo-ref "$api_repo=$unavailable_ref"');
    expect(source).toContain('repo show "$project_name" broken --json');
    expect(source).toContain('--repo-ref "$api_repo=$candidate_ref"');
  });
});
