import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostMirrorOwnership,
  parseHostMirrorOwnership
} from "../../../../core/packages/core/src/hostMirrorOwnership.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host mirror ownership", () => {
  it("creates independent unpredictable service and resource identities", () => {
    const first = createHostMirrorOwnership();
    const second = createHostMirrorOwnership();
    const firstIdentities = [first.serviceId, ...Object.values(first.resourceIds)];
    const secondIdentities = [second.serviceId, ...Object.values(second.resourceIds)];

    expect(firstIdentities).toHaveLength(6);
    expect(new Set(firstIdentities)).toHaveLength(6);
    expect(firstIdentities.every((identity) => /^[A-Za-z0-9_-]{43}$/.test(identity))).toBe(true);
    expect(secondIdentities).not.toEqual(firstIdentities);
  });

  it("persists one exact identity set across lifecycle state reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-host-mirror-ownership-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const ownership = createHostMirrorOwnership();

    await state.writeHostMirrorOwnership(ownership);

    await expect(state.readHostMirrorOwnership()).resolves.toEqual(ownership);
  });

  it("rejects predictable legacy ownership labels", () => {
    expect(() => parseHostMirrorOwnership({
      schemaVersion: 1,
      serviceId: "host-mirror-v1",
      resourceIds: {
        "control-network": "control-network-v1",
        "registry-cache-data": "registry-cache-data-v1",
        "registry-cache": "registry-cache-v1",
        "apt-cache-data": "apt-cache-data-v1",
        "apt-cache": "apt-cache-v1"
      }
    })).toThrow(/ownership state is invalid/);
  });
});
