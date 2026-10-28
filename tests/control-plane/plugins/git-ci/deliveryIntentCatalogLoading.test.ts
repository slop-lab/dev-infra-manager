import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as reconciliation from "../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-reconciliation.js";
import type { DeliveryIntentCatalogState } from "../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-retained.js";

it("counts an in-flight directory load before another repository can claim the last catalog slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-intent-catalog-loading-"));
  const release = Promise.withResolvers<void>();
  try {
    const firstDirectory = join(root, "first"), secondDirectory = join(root, "second");
    await Promise.all([firstDirectory, secondDirectory].map((path) => mkdir(path, { mode: 0o700 })));
    const catalogs = new Map<string, DeliveryIntentCatalogState>();
    const entered = Promise.withResolvers<void>();
    const first = reconciliation.loadDeliveryIntentCatalog({ directory: firstDirectory, catalogs, maximumCatalogs: 1,
      async reconcile(catalog, before) {
        entered.resolve();
        await release.promise;
        catalog.directoryVersion = before;
        catalog.initialized = true;
      } });
    await entered.promise;
    await expect(reconciliation.loadDeliveryIntentCatalog({ directory: secondDirectory, catalogs, maximumCatalogs: 1,
      async reconcile() {} })).rejects.toThrow(/capacity/i);
    release.resolve();
    await first;
    expect(catalogs.size).toBe(1);
  } finally { release.resolve(); await rm(root, { recursive: true, force: true }); }
});

it("releases only a failed initial directory load so another catalog can use its slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-intent-catalog-load-failure-"));
  try {
    const catalogs = new Map<string, DeliveryIntentCatalogState>();
    await expect(reconciliation.loadDeliveryIntentCatalog({ directory, catalogs, maximumCatalogs: 1,
      async reconcile() { throw new CatalogLoadFault(); } })).rejects.toThrow(CatalogLoadFault);
    expect(catalogs.size).toBe(0);
    const loaded = await reconciliation.loadDeliveryIntentCatalog({ directory, catalogs, maximumCatalogs: 1,
      async reconcile(catalog, before) { catalog.directoryVersion = before; catalog.initialized = true; } });
    expect(loaded.initialized).toBe(true);
    expect(catalogs.size).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

class CatalogLoadFault extends Error { readonly name = "CatalogLoadFault"; }
