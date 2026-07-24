import { describe, expect, it, vi } from "vitest";
import {
  DIM_PLUGIN_API_VERSION,
  PluginRegistry,
  registerPlugin,
  type RepositoryProvider
} from "../src/plugin.js";

describe("plugin registry", () => {
  it("registers repository providers through a versioned plugin contract", async () => {
    const registry = new PluginRegistry();
    const register = vi.fn();
    const provider = { kind: "github-mirror", register } satisfies RepositoryProvider;

    await registerPlugin(registry, {
      name: "@dev-infra-manager/plugin-github",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerRepositoryProvider(provider);
      }
    });

    expect(registry.repositoryProviderKinds()).toEqual(["github-mirror"]);
    expect(registry.repositoryProvider("github-mirror")).toBe(provider);
  });

  it("rejects duplicate and unavailable providers", () => {
    const registry = new PluginRegistry();
    const provider = {
      kind: "github-mirror",
      register: vi.fn()
    } satisfies RepositoryProvider;
    registry.registerRepositoryProvider(provider);
    expect(() => registry.registerRepositoryProvider(provider)).toThrow(/already registered/);
    expect(() => registry.repositoryProvider("gitlab-mirror")).toThrow(/not installed/);
  });
});
