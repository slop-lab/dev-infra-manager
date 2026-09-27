import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const verificationRoot = resolve(import.meta.dirname, "..");
const managedSmokeScript = resolve(verificationRoot, "scripts/registry-cache-routing-managed-smoke.bash");

describe("registry cache routing shell contracts", () => {
  it("uses exact managed resource identities and rejects collisions before creation", async () => {
    // Given
    const managedSmoke = await readFile(managedSmokeScript, "utf8");

    // When
    const firstCreate = managedSmoke.indexOf("docker network create");

    // Then
    expect(managedSmoke).toContain('cache="dim-registry-cache"');
    expect(managedSmoke).toContain('network="dim-control"');
    expect(managedSmoke).toContain('cache_volume="dim-registry-cache-data"');
    expect(managedSmoke).toContain("dim.managed=true");
    expect(managedSmoke).toContain("dim.resource=registry-cache");
    expect(managedSmoke.indexOf("dim_registry_refuse_managed_collisions")).toBeLessThan(firstCreate);
    expect(managedSmoke).not.toMatch(/(?:--publish|-p)[ =]/);
  });

  it("owns unconditional exact-name cleanup only after collision refusal", async () => {
    // Given
    const managedSmoke = await readFile(managedSmokeScript, "utf8");

    // When
    const networkCreate = managedSmoke.indexOf("docker network create");
    const volumeCreate = managedSmoke.indexOf("docker volume create");
    const cacheCreate = managedSmoke.indexOf('docker run --detach --name "$cache"');
    const cleanupOwned = managedSmoke.indexOf("cleanup_exact_resources=1");
    const removeCache = managedSmoke.indexOf('docker rm --force "$cache"');
    const removeNetwork = managedSmoke.indexOf('docker network rm "$network"');
    const removeVolume = managedSmoke.indexOf('docker volume rm "$cache_volume"');

    // Then
    expect(managedSmoke.indexOf("dim_registry_refuse_managed_collisions")).toBeLessThan(cleanupOwned);
    expect(cleanupOwned).toBeLessThan(networkCreate);
    expect(networkCreate).toBeLessThan(volumeCreate);
    expect(volumeCreate).toBeLessThan(cacheCreate);
    expect(managedSmoke).toContain('if [[ "$cleanup_exact_resources" -eq 1 ]]; then');
    expect(removeCache).toBeLessThan(removeNetwork);
    expect(removeNetwork).toBeLessThan(removeVolume);
  });
});
