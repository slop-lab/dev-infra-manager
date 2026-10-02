import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cli = path.resolve(
  import.meta.dirname,
  "../../../../core/packages/controller-proxy/dist/development-service-cli.js"
);

describe("published development service CLI", () => {
  it("rejects a service name with a trailing hyphen", () => {
    // Given: the built CLI and a service name that would end its DNS label with a hyphen.
    const arguments_ = [cli, "workspace-subdomain", "--workspace", "work", "--service", "preview-"];

    // When: the published command generates a workspace service subdomain.
    const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

    // Then: it fails without emitting a label.
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toBe("service name must be a lowercase DNS label\n");
  });

  it("emits a valid OpenCode workspace service label", () => {
    // Given: the built CLI and the reviewed OpenCode service name.
    const arguments_ = [cli, "workspace-subdomain", "--workspace", "work", "--service", "opencode"];

    // When: the published command generates a workspace service subdomain.
    const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

    // Then: the command succeeds with one DNS-safe label.
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trim()).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(result.stdout).toMatch(/--opencode\n$/);
  });
});
