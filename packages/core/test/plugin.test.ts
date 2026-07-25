import { describe, expect, it, vi } from "vitest";
import {
  DIM_PLUGIN_API_VERSION,
  registerPlugin,
  registerPlugins
} from "../src/plugin.js";

describe("plugin contract", () => {
  it("loads plugins through a versioned contract", async () => {
    const register = vi.fn();

    await registerPlugin({
      name: "@example/dim-plugin",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register
    });

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      apiVersion: DIM_PLUGIN_API_VERSION,
      registerExternalRouteProvider: expect.any(Function),
      registerExternalUrlProvider: expect.any(Function)
    }));
  });

  it("rejects unsupported plugin API versions", async () => {
    await expect(registerPlugin({
      name: "@example/future-plugin",
      apiVersion: 3 as typeof DIM_PLUGIN_API_VERSION,
      register: vi.fn()
    })).rejects.toThrow(/unsupported DIM plugin API/);
  });

  it("collects capabilities and disposes plugins in reverse order", async () => {
    const disposed: string[] = [];
    const registered = await registerPlugins([
      {
        name: "first",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerExternalRouteProvider({
            name: "proxy",
            provision: async () => ({ authority: "proxy.internal", protocol: "http" }),
            revoke: async () => {}
          });
          return () => { disposed.push("first"); };
        }
      },
      {
        name: "second",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerExternalUrlProvider({
            name: "tailnet",
            publish: async () => ({ url: "https://example.test" }),
            revoke: async () => {}
          });
          return () => { disposed.push("second"); };
        }
      }
    ]);

    expect([...registered.externalRouteProviders.keys()]).toEqual(["proxy"]);
    expect([...registered.externalUrlProviders.keys()]).toEqual(["tailnet"]);
    await registered.dispose();
    await registered.dispose();
    expect(disposed).toEqual(["second", "first"]);
  });

  it("rejects duplicate capability names", async () => {
    await expect(registerPlugins([
      {
        name: "one",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerExternalUrlProvider({
            name: "same",
            publish: async () => ({ url: "https://one.test" }),
            revoke: async () => {}
          });
        }
      },
      {
        name: "two",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerExternalUrlProvider({
            name: "same",
            publish: async () => ({ url: "https://two.test" }),
            revoke: async () => {}
          });
        }
      }
    ])).rejects.toThrow(/already registered/);
  });
});
