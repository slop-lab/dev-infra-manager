import { describe, expect, it } from "vitest";
import { registerPlugin } from "@slop-lab/dim-core";
import plugin, { hostMirrorProvider } from "../../plugin-host-mirrors/src/index.js";

describe("host mirror plugin", () => {
  it("registers its reviewed immutable Docker and APT service images", async () => {
    // Given / When
    const registered = await registerPlugin(plugin);

    // Then
    expect(registered.host.extension("dim.host-mirror-provider", "host")).toEqual(hostMirrorProvider);
    expect(hostMirrorProvider.dockerImage).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(hostMirrorProvider.aptImage).toMatch(/@sha256:[0-9a-f]{64}$/);
    await registered.dispose();
  });
});
