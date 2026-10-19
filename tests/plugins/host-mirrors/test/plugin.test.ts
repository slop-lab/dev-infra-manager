import { describe, expect, it } from "vitest";
import { registerPlugin } from "@slop-lab/dim-managed";
import plugin, { hostMirrorProvider } from "../../../../packages/host/plugins/mirrors/src/index.js";

describe("host mirror plugin", () => {
  it("registers client routing without installing cache services", async () => {
    // Given / When
    const registered = await registerPlugin(plugin);

    // Then
    expect(registered.host.extension("dim.host-mirror-provider", "host")).toEqual(hostMirrorProvider);
    await registered.dispose();
  });
});
