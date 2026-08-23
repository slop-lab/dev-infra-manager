import { describe, expect, it } from "vitest";
import {
  CONTROL_NETWORK,
  REGISTRY_CACHE_CONTAINER,
  REGISTRY_CACHE_ENDPOINT,
  REGISTRY_CACHE_IMAGE,
  REGISTRY_CACHE_VOLUME,
  registryCacheContainerArgs,
  sysboxRegistryConfigArgs
} from "../../../../core/packages/core/src/registryCache.js";

describe("registry cache", () => {
  it("runs an internal pinned Docker Hub pull-through cache", () => {
    const args = registryCacheContainerArgs();
    expect(REGISTRY_CACHE_ENDPOINT).toBe("dim-registry-cache:5000");
    expect(args).toEqual(expect.arrayContaining([
      "--name", REGISTRY_CACHE_CONTAINER,
      "--network", CONTROL_NETWORK,
      "--mount", `type=volume,source=${REGISTRY_CACHE_VOLUME},target=/var/lib/registry`,
      "--env", "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
      "--env", "REGISTRY_STORAGE_DELETE_ENABLED=true",
      REGISTRY_CACHE_IMAGE
    ]));
    expect(args).not.toContain("--publish");
    expect(REGISTRY_CACHE_IMAGE).toMatch(/^registry@sha256:[0-9a-f]{64}$/);
  });

  it("writes the Sysbox daemon mirror into its existing runner volume", () => {
    const args = sysboxRegistryConfigArgs("runner-data");
    expect(args).toContain("type=volume,source=runner-data,target=/data");
    const encoded = args.find((argument) => argument.startsWith("DIM_REGISTRY_DAEMON_CONFIG="));
    expect(encoded).toBeDefined();
    const config = JSON.parse(Buffer.from(encoded!.slice(encoded!.indexOf("=") + 1), "base64").toString("utf8"));
    expect(config).toEqual({
      "registry-mirrors": ["http://dim-registry-cache:5000"],
      "insecure-registries": ["dim-registry-cache:5000"]
    });
  });
});
