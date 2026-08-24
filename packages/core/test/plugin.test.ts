import { describe, expect, it, vi } from "vitest";
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin,
  registerPlugin,
  registerPlugins
} from "../../../../core/packages/core/src/plugin.js";

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
      registerControllerRoute: expect.any(Function),
      registerHostInputProvider: expect.any(Function),
      registerExtension: expect.any(Function),
      extension: expect.any(Function)
    }));
  });

  it("rejects unsupported plugin API versions", async () => {
    await expect(registerPlugin({
      name: "@example/future-plugin",
      apiVersion: 4 as typeof DIM_PLUGIN_API_VERSION,
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
          host.registerControllerRoute({
            method: "GET",
            path: "/first",
            summary: "first route",
            handle: async () => ({ body: { ok: true } })
          });
          return () => { disposed.push("first"); };
        }
      },
      {
        name: "second",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerControllerRoute({
            method: "POST",
            path: "/second/:id",
            summary: "second route",
            handle: async () => ({ status: 204 })
          });
          return () => { disposed.push("second"); };
        }
      }
    ]);

    expect(registered.controllerRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /first",
      "POST /second/:id"
    ]);
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
          host.registerControllerRoute({
            method: "GET",
            path: "/same",
            summary: "same",
            handle: async () => {}
          });
        }
      },
      {
        name: "two",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerControllerRoute({
            method: "GET",
            path: "/same",
            summary: "same again",
            handle: async () => {}
          });
        }
      }
    ])).rejects.toThrow(/already registered/);
  });

  it("closes registration after plugin startup", async () => {
    let captured: Parameters<DimPlugin["register"]>[0] | undefined;
    const registered = await registerPlugins([{
      name: "capture",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        captured = host;
      }
    }]);
    expect(() => captured?.registerControllerRoute({
      method: "GET",
      path: "/late",
      summary: "late",
      handle: async () => {}
    })).toThrow(/after startup/);
    await registered.dispose();
  });

  it("registers host input providers and rejects duplicate names", async () => {
    await expect(registerPlugins([
      {
        name: "one",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerHostInputProvider("example.setting", { resolve: async () => "one" });
        }
      },
      {
        name: "two",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerHostInputProvider("example.setting", { resolve: async () => "two" });
        }
      }
    ])).rejects.toThrow(/already registered/);
  });

  it("shares named extensions between plugins and rejects duplicates", async () => {
    const capability = { value: "cloudflare" };
    await expect(registerPlugins([
      {
        name: "provider",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          host.registerExtension("external-url.dns-provider", "cloudflare", capability);
        }
      },
      {
        name: "consumer",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) {
          expect(host.extension("external-url.dns-provider", "cloudflare")).toBe(capability);
          expect(() => host.registerExtension(
            "external-url.dns-provider",
            "cloudflare",
            {}
          )).toThrow(/already registered/);
        }
      }
    ])).resolves.toBeDefined();
  });
});
