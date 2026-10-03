import { describe, expect, it, vi } from "vitest";
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin,
  registerPlugin,
  registerPlugins
} from "../../../../core/packages/core/src/plugin.js";
import {
  registerHostMirrorProvider,
  resolveHostMirrorProvider
} from "../../../../core/packages/core/src/hostMirrorProvider.js";

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
      registerWorkspaceDiscardHook: expect.any(Function),
      registerHostInputProvider: expect.any(Function),
      registerWorkspaceCapability: expect.any(Function),
      registerExtension: expect.any(Function),
      extension: expect.any(Function)
    }));
  });

  it("rejects unsupported plugin API versions", async () => {
    await expect(registerPlugin({
      name: "@example/future-plugin",
      apiVersion: 5 as typeof DIM_PLUGIN_API_VERSION,
      register: vi.fn()
    })).rejects.toThrow(/unsupported DIM plugin API/);
  });

  it("rejects controller routes without an explicit audience", async () => {
    await expect(registerPlugin({
      name: "missing-audience",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerControllerRoute({
          method: "GET",
          path: "/unsafe",
          summary: "unsafe",
          handle: async () => undefined
        } as never);
      }
    })).rejects.toThrow(/without valid audiences/);
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
            audiences: ["workspace"],
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
            audiences: ["agent"],
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

  it("collects generic workspace discard hooks in plugin order", async () => {
    // Given: two plugins that own workspace-scoped host resources.
    const first = { beforeDiscard: vi.fn() };
    const second = { beforeDiscard: vi.fn() };

    // When: both plugins register their lifecycle hooks.
    const registered = await registerPlugins([
      {
        name: "first-hook",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) { host.registerWorkspaceDiscardHook(first); }
      },
      {
        name: "second-hook",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) { host.registerWorkspaceDiscardHook(second); }
      }
    ]);

    // Then: authoritative lifecycle callers can invoke every registered hook.
    expect(registered.workspaceDiscardHooks).toEqual([first, second]);
    await registered.dispose();
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
            audiences: ["workspace"],
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
            audiences: ["workspace"],
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
      audiences: ["workspace"],
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

  it("registers workspace capability providers by exact name", async () => {
    const provider = { provision: vi.fn(async () => ({ capabilities: ["SYS_ADMIN"] })) };
    const registered = await registerPlugin({
      name: "capability-plugin",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) { host.registerWorkspaceCapability("writable-cgroup", provider); }
    });
    expect(registered.workspaceCapabilityProviders.get("writable-cgroup")).toEqual({
      plugin: "capability-plugin", provider
    });
    await registered.dispose();
  });

  it("registers one host-owned mirror provider with immutable service images", async () => {
    // Given
    const provider = {
      dockerImage: `registry.example/cache@sha256:${"a".repeat(64)}`,
      aptImage: `registry.example/apt-cache@sha256:${"b".repeat(64)}`
    };

    // When
    const registered = await registerPlugin({
      name: "host-mirrors",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) { registerHostMirrorProvider(host, provider); }
    });

    // Then
    expect(resolveHostMirrorProvider(registered.host)).toEqual(provider);
    await registered.dispose();
  });

  it("rejects mutable and duplicate host mirror providers", async () => {
    // Given
    const immutable = {
      dockerImage: `registry.example/cache@sha256:${"a".repeat(64)}`,
      aptImage: `registry.example/apt-cache@sha256:${"b".repeat(64)}`
    };

    // When / Then
    await expect(registerPlugin({
      name: "mutable-mirrors",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        registerHostMirrorProvider(host, { ...immutable, aptImage: "registry.example/apt-cache:latest" });
      }
    })).rejects.toThrow(/immutable digest/);
    await expect(registerPlugins([
      {
        name: "first-mirrors",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) { registerHostMirrorProvider(host, immutable); }
      },
      {
        name: "second-mirrors",
        apiVersion: DIM_PLUGIN_API_VERSION,
        register(host) { registerHostMirrorProvider(host, immutable); }
      }
    ])).rejects.toThrow(/already registered/);
  });

  it("rejects a second host mirror provider registered under another name", async () => {
    // Given
    const provider = {
      dockerImage: `registry.example/cache@sha256:${"a".repeat(64)}`,
      aptImage: `registry.example/apt-cache@sha256:${"b".repeat(64)}`
    };

    // When
    const registration = registerPlugin({
      name: "ambiguous-mirrors",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerExtension("dim.host-mirror-provider", "primary", provider);
        host.registerExtension("dim.host-mirror-provider", "secondary", provider);
      }
    });

    // Then
    await expect(registration).rejects.toThrow(/host mirror provider.*already registered/);
  });

  it("rejects a malformed host mirror provider registered through the generic extension API", async () => {
    // Given / When
    const registration = registerPlugin({
      name: "malformed-mirrors",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerExtension("dim.host-mirror-provider", "host", {});
      }
    });

    // Then
    await expect(registration).rejects.toThrow(/host mirror provider images must use an immutable digest/);
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
