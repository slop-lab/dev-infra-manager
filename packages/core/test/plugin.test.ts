import { describe, expect, it, vi } from "vitest";
import {
  DIM_PLUGIN_API_VERSION,
  registerPlugin
} from "../src/plugin.js";

describe("plugin contract", () => {
  it("loads plugins through a versioned contract", async () => {
    const register = vi.fn();

    await registerPlugin({
      name: "@example/dim-plugin",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register
    });

    expect(register).toHaveBeenCalledWith({});
  });

  it("rejects unsupported plugin API versions", async () => {
    await expect(registerPlugin({
      name: "@example/future-plugin",
      apiVersion: 2 as typeof DIM_PLUGIN_API_VERSION,
      register: vi.fn()
    })).rejects.toThrow(/unsupported DIM plugin API/);
  });
});
