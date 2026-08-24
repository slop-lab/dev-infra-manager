import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("DIM development forge policy", () => {
  it("pins every split repository to its reviewed development and publish ref", async () => {
    const manifest = parse(await readFile(resolve(repositoryRoot, ".dim/repos.yml"), "utf8"));
    const expected = [
      "root", "development", "core", "core-development",
      "plugin-dns-cloudflare", "plugin-dns-cloudflare-development",
      "plugin-external-urls", "plugin-external-urls-development",
      "verification", "examples", "specification"
    ];

    expect(manifest?.schemaVersion).toBe(1);
    expect(manifest.upstreams).toEqual({
      archive: { url: "https://github.com/slop-lab/dev-infra-manager.git" }
    });
    expect(Object.keys(manifest.repositories).sort()).toEqual(expected.sort());
    for (const alias of expected) {
      const repository = manifest.repositories[alias];
      const externalRef = `dev/${alias}`;
      expect(repository.upstream).toBe("archive");
      expect(repository.import).toEqual({ main: externalRef });
      expect(repository.publish).toEqual({ main: "main" });
      expect(repository.protect ?? []).toEqual(["root", "development"].includes(alias) ? ["main"] : []);
      expect(repository.ref).toBe(alias === "root" ? "main" : undefined);
      expect(repository.root).toBe(alias === "root" ? true : undefined);
    }
  });

  it("reserves disposable QEMU gates for non-draft promotions to managed main", async () => {
    const workflow = parse(await readFile(resolve(repositoryRoot, ".gitea/workflows/ci.yml"), "utf8"));
    const condition = String(workflow?.jobs?.["host-backend"]?.if ?? "");

    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("github.event.pull_request.draft == false");
    expect(workflow?.jobs?.["source-compatibility"]?.if).toBeUndefined();
    expect(workflow?.jobs?.["workspace-integration"]?.if).toBeUndefined();
  });
});
