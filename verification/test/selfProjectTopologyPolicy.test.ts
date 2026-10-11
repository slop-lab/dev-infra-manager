import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM monorepo self-project topology policy", () => {
  it("materializes the single reviewed repository for self-Project verification", async () => {
    const setup = await readFile(
      resolve(workspaceRoot, "verification/scripts/lib/container-self-project-setup.bash"),
      "utf8"
    );

    expect(setup).toContain('git -C "$project_source" rev-parse --show-toplevel');
    expect(setup).toContain('[[ "$canonical_root" == "$project_source"');
    expect(setup).toContain('mkdir -p "$source_root/repositories/root"');
    expect(setup).toContain('dim_prepare_clone_source "$project_source" "$source_root/snapshot-root"');
    expect(setup).not.toMatch(/core-development|plugin-dns-cloudflare-development|plugin-external-urls-development/);
  });

  it("keeps single-tree proposals protected and external publication host-authorized", async () => {
    const agentChecks = await readFile(
      resolve(workspaceRoot, "verification/scripts/lib/container-self-project-agent-checks.bash"),
      "utf8"
    );
    const publicationChecks = await readFile(
      resolve(workspaceRoot, "verification/scripts/lib/container-self-project-final-phases.bash"),
      "utf8"
    );

    expect(agentChecks).toContain("proposal_repository=root");
    expect(agentChecks).toContain("! git push origin HEAD:refs/heads/main");
    expect(agentChecks).toContain("/tmp/dim-self-project-root/.dim/workspace-repositories.json");
    expect(publicationChecks).toContain("canonical-root external publication unexpectedly succeeded");
    expect(publicationChecks).toContain("repository synchronization requires DIM_GIT_SYNC_CONNECTION_FILE");
  });

  it("starts both private daemons with only their dedicated Unix listeners", async () => {
    const projectRoot = resolve(workspaceRoot, ".dim");
    const agentEntrypoint = await readFile(resolve(projectRoot, "agent-dind/entrypoint.sh"), "utf8");
    const secureEntrypoint = await readFile(resolve(projectRoot, "secure-dind/entrypoint.sh"), "utf8");

    expect(agentEntrypoint).toContain('dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"');
    expect(secureEntrypoint).toContain('dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"');
    expect(`${agentEntrypoint}\n${secureEntrypoint}`).not.toMatch(/dockerd-entrypoint\.sh "\$@"|2375|2376/);
  });

  it("does not signal a reused controller-proxy PID", async () => {
    const setup = await readFile(resolve(workspaceRoot, ".dim/setup.sh"), "utf8");

    expect(setup).toContain('[ "$old_proxy_pid" != "$$" ]');
    expect(setup).toContain('tr \'\\000\' \'\\n\' <"/proc/$old_proxy_pid/cmdline"');
    expect(setup).toContain("grep -Fq dim-controller-proxy");
  });

  it("binds the Project contract to the single reviewed repository", async () => {
    const repositories = parse(await readFile(resolve(workspaceRoot, ".dim/repos.yml"), "utf8"));
    const workspaceRepositories = JSON.parse(
      await readFile(resolve(workspaceRoot, ".dim/workspace-repositories.json"), "utf8")
    );

    const expectedArchive = process.env.DIM_EXPECT_ARCHIVE_URL;
    expect(repositories).toEqual({
      schemaVersion: 1,
      upstreams: { root: { url: expectedArchive ?? "https://github.com/slop-lab/dev-infra-manager.git" } },
      repositories: {
        root: {
          upstream: "root",
          root: true,
          ref: "main",
          import: { main: expectedArchive === undefined ? "main" : "dev/root" },
          protect: ["main"],
          blockForcePush: ["main"],
          publish: { main: "main" }
        }
      }
    });
    expect(workspaceRepositories).toEqual({
      schemaVersion: 1,
      repositories: { root: { ref: "main", path: "workspace" } }
    });
  });

});
