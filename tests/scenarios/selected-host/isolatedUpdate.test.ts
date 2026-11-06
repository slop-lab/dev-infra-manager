import { expect, it, vi } from "vitest";
import { isolatedEnvironment } from "./isolatedUpdate.js";

it("isolates installation and workspace state without inheriting live DIM selection or Node preloads", () => {
  vi.stubEnv("DIM_HOST_EXECUTABLE", "/live/host"); vi.stubEnv("DIM_PLUGIN_HOME", "/live/plugins"); vi.stubEnv("NODE_OPTIONS", "--import=/live/preload");
  try {
    const env = isolatedEnvironment("/private/disposable", "/private/disposable/home");
    expect(env.DIM_STATE_ROOT).toBe("/private/disposable/state");
    expect(env.DIM_CONFIG_PATH).toBe("/private/disposable/config/dim/config.json");
    expect(env.DIM_DATA_HOME).toBe("/private/disposable/data/dim");
    expect(env.DIM_HOST_EXECUTABLE).toBeUndefined(); expect(env.DIM_PLUGIN_HOME).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined();
  } finally { vi.unstubAllEnvs(); }
});
