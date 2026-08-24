import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("DIM development forge policy", () => {
  it("pins every split repository to its reviewed development and publish ref", async () => {
    const manifest = parse(await readFile(resolve(workspaceRoot, "project/.dim/repos.yml"), "utf8"));
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
});
