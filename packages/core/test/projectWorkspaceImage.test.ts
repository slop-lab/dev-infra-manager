import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Project workspace image", () => {
  it("honors the legacy iptables runtime selection before starting dockerd", async () => {
    const entrypoint = await readFile(
      resolve(import.meta.dirname, "../../../../core/images/project-workspace/entrypoint.bash"),
      "utf8"
    );

    const selection = entrypoint.indexOf('/usr/local/sbin/.iptables-legacy:$PATH');
    const dockerd = entrypoint.indexOf('dockerd "${dockerd_args[@]}"');
    expect(selection).toBeGreaterThan(-1);
    expect(dockerd).toBeGreaterThan(selection);
  });
});
