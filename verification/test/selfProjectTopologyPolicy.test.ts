import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM monorepo self-project topology policy", () => {
  it("starts both private daemons with only their dedicated Unix listeners", async () => {
    const projectRoot = resolve(workspaceRoot, ".dim");
    const agentEntrypoint = await readFile(resolve(projectRoot, "agent-dind/entrypoint.sh"), "utf8");
    const secureEntrypoint = await readFile(resolve(projectRoot, "secure-dind/entrypoint.sh"), "utf8");

    expect(agentEntrypoint).toContain('dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"');
    expect(secureEntrypoint).toContain('dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"');
    expect(`${agentEntrypoint}\n${secureEntrypoint}`).not.toMatch(/dockerd-entrypoint\.sh "\$@"|2375|2376/);
  });

  it("binds the Project contract to the single reviewed repository", async () => {
    const repositories = parse(await readFile(resolve(workspaceRoot, ".dim/repos.yml"), "utf8"));
    const workspaceRepositories = JSON.parse(
      await readFile(resolve(workspaceRoot, ".dim/workspace-repositories.json"), "utf8")
    );

    expect(repositories).toEqual({
      schemaVersion: 1,
      upstreams: { root: { url: "https://github.com/slop-lab/dev-infra-manager.git" } },
      repositories: {
        root: {
          upstream: "root",
          root: true,
          ref: "main",
          import: { main: "main" },
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

  it("records every split source and candidate-only trusted overlay", async () => {
    const sourceLines = (await readFile(resolve(workspaceRoot, ".monorepo-candidate/sources.tsv"), "utf8"))
      .trim().split("\n").slice(1).map((line) => line.split("\t"));
    const overlayLines = (await readFile(resolve(workspaceRoot, ".monorepo-candidate/overlay.tsv"), "utf8"))
      .trim().split("\n").slice(1).map((line) => line.split("\t"));

    expect(sourceLines.map(([repository]) => repository).sort()).toEqual([
      "core", "core-development", "development", "examples", "plugin-dns-cloudflare",
      "plugin-dns-cloudflare-development", "plugin-external-urls",
      "plugin-external-urls-development", "root", "specification", "verification"
    ]);
    expect(sourceLines.every((fields) => fields.length === 5 && /^[0-9a-f]{40}$/.test(fields[2] ?? ""))).toBe(true);
    expect(Object.fromEntries(sourceLines.map(([repository, destination]) => [repository, destination]))).toEqual({
      development: ".", root: ".", core: "core", "core-development": "core-development",
      "plugin-dns-cloudflare": "plugin-dns-cloudflare",
      "plugin-dns-cloudflare-development": "plugin-dns-cloudflare-development",
      "plugin-external-urls": "plugin-external-urls",
      "plugin-external-urls-development": "plugin-external-urls-development",
      verification: "verification", examples: "examples", specification: "specification"
    });
    expect(overlayLines.every((fields) => fields.length === 3 && /^[0-9a-f]{64}$/.test(fields[2] ?? ""))).toBe(true);
    expect(overlayLines.map(([, target]) => target).sort()).toEqual([
      ".dim/reconcile-repositories.sh", ".dim/repos.yml", ".dim/workspace-repositories.json",
      ".gitea/CODEOWNERS", "git-apply", "verification-layout",
      "verification/test/selfProjectTopologyPolicy.test.ts"
    ]);
  });
});
