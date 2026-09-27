import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const verificationRoot = resolve(import.meta.dirname, "..");
const journeyLibrary = resolve(verificationRoot, "scripts/lib/registry-cache-routing-journey.bash");

describe("registry cache routing shell contracts", () => {
  it("refreshes and verifies the managed cache address after every replacement", async () => {
    const journeyHooks = await readFile(journeyLibrary, "utf8");
    const refresh = (replacementAddress: string) => spawnSync("bash", [
      "-c",
       'set -e; source "$1"; docker() { printf "%s\\n" "$DIM_TEST_CACHE_ADDRESS"; }; export -f docker; DIM_CACHE_ROUTING_NETWORK=dim-control DIM_CACHE_ROUTING_CACHE=dim-registry-cache dim_cache_routing_refresh_cache_address 172.18.0.2; printf "%s\\n" "$DIM_CI_REGISTRY_CACHE_UPSTREAM"',
      "bash", journeyLibrary
    ], { encoding: "utf8", env: { ...process.env, DIM_TEST_CACHE_ADDRESS: replacementAddress } });

    expect(journeyHooks).toContain("dim_cache_routing_refresh_cache_address");
    expect(journeyHooks).toContain('DIM_CI_REGISTRY_CACHE_UPSTREAM="$DIM_CACHE_ROUTING_CACHE:5000"');
    expect(journeyHooks).toContain('[[ "$replacement_address" != "$previous_address" ]]');
    expect(refresh("172.18.0.2").status).not.toBe(0);
    expect(refresh("172.18.0.3").status).toBe(0);
    expect(refresh("172.18.0.3").stdout.trim()).toBe("dim-registry-cache:5000");
  });
});
