import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tailscaleIngressDriver, tailscaleSelfAddress } from "../../../../packages/host/plugins/tailscale/src/ingress.js";

describe("Tailscale status", () => {
  it("selects only the running host self CGNAT address", () => {
    expect(tailscaleSelfAddress({
      BackendState: "Running",
      Self: { TailscaleIPs: ["fd7a:115c:a1e0::1", "100.100.10.20"] }
    })).toBe("100.100.10.20");
    expect(() => tailscaleSelfAddress({
      BackendState: "Running",
      Self: { TailscaleIPs: ["127.0.0.1"] }
    })).toThrow(/allowed tailnet IPv4 address/);
    expect(() => tailscaleSelfAddress({ BackendState: "Stopped", Self: { TailscaleIPs: ["100.100.10.20"] } }))
      .toThrow(/not running/);
  });

  it("reads the current host address without changing Tailscale state", async () => {
    // Given: a host Tailscale CLI that exposes only status and records every invocation.
    const root = await mkdtemp(path.join(tmpdir(), "dim-tailscale-status-"));
    const command = path.join(root, "tailscale");
    const calls = path.join(root, "calls");
    await writeFile(command, `#!/bin/sh
printf '%s\\n' "$*" >>${JSON.stringify(calls)}
test "$1 $2" = 'status --json'
printf '%s\\n' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.100.10.20"]}}'
`);
    await chmod(command, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    try {
      // When: the opt-in driver resolves its persisted high port.
      const runtime = await tailscaleIngressDriver.runtime('{"listenPort":49152}');

      // Then: it binds and advertises only the current self address and invokes no mutating command.
      expect(runtime).toEqual({
        scheme: "tcp",
        domain: "100.100.10.20",
        listenHost: "100.100.10.20",
        listenPort: 49152,
      });
      expect(await readFile(calls, "utf8")).toBe("status --json\n");
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});

