import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM self-project topology policy", () => {
  it("pins every split repository to its reviewed archive branch", async () => {
    const manifest = parse(await readFile(resolve(workspaceRoot, "project/.dim/repos.yml"), "utf8"));
    const expectedUpstreams = {
      root: "https://gitlab.com/slop-lab/dim/root.git",
      development: "https://gitlab.com/slop-lab/dim/essential-dev/root.git",
      core: "https://gitlab.com/slop-lab/dim/essential/core.git",
      "core-development": "https://gitlab.com/slop-lab/dim/essential-dev/core.git",
      "plugin-dns-cloudflare": "https://gitlab.com/slop-lab/dim/essential/plugin-dns-cloudflare.git",
      "plugin-dns-cloudflare-development": "https://gitlab.com/slop-lab/dim/essential-dev/plugin-dns-cloudflare.git",
      "plugin-external-urls": "https://gitlab.com/slop-lab/dim/essential/plugin-external-urls.git",
      "plugin-external-urls-development": "https://gitlab.com/slop-lab/dim/essential-dev/plugin-external-urls.git",
      verification: "https://gitlab.com/slop-lab/dim/dev/verification.git",
      examples: "https://gitlab.com/slop-lab/dim/dev/examples.git",
      specification: "https://gitlab.com/slop-lab/dim/dev/specification.git"
    };
    const expected = Object.keys(expectedUpstreams);

    expect(manifest?.schemaVersion).toBe(1);
    expect(manifest.upstreams).toEqual(
      Object.fromEntries(Object.entries(expectedUpstreams).map(([alias, url]) => [alias, { url }]))
    );
    expect(Object.keys(manifest.repositories).sort()).toEqual(expected.sort());
    for (const alias of expected) {
      const repository = manifest.repositories[alias];
      expect(repository.upstream).toBe(alias);
      expect(repository.import).toEqual({ main: "main" });
      expect(repository.publish).toEqual({ main: "main" });
      expect(repository.protect ?? []).toEqual(["root", "development"].includes(alias) ? ["main"] : []);
      expect(repository.ref).toBe("main");
      expect(repository.root).toBe(alias === "root" ? true : undefined);
    }

    const smoke = await readFile(resolve(workspaceRoot, "verification/scripts/container-self-project-smoke.bash"), "utf8");
    const repositoryLoop = smoke.match(/for repository in ([\s\S]*?); do/);
    expect(repositoryLoop?.[1]?.replaceAll("\\", "").trim().split(/\s+/).sort()).toEqual(expected.sort());
    expect(smoke).toContain('git init --bare "$source_root/remotes/archive.git"');
    expect(smoke).toContain('git -C "$repository_path" push "$source_root/remotes/archive.git" \\');
    expect(smoke).toContain('"HEAD:refs/heads/dev/$repository"');

    const createStart = smoke.indexOf('dim project create "$project_name" \\');
    const createEnd = smoke.indexOf("\nverification_stage=", createStart);
    const createCommand = smoke.slice(createStart, createEnd);
    expect(createCommand).toContain('--bootstrap-git-url "$source_root/remotes/archive.git"');
    expect(createCommand).toContain('--bootstrap-git-ref "$root_ref"');
    expect(createCommand).not.toContain("--apply-repos");
    expect(smoke).toContain("config.import = { main: `dev/${repository}` }");
    expect(smoke).toContain('--initial-branch="dev/$repository"');
  });
});
