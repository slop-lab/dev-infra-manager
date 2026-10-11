import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNativeRootAdmissionDatabase } from "../../core/packages/core/src/nativeRootAdmissionSchema.js";
import { createNativeGitBundleDatabase } from "../../core/packages/native-git/src/native-bundle-state-validation.js";
import {
  nativeAuthorityTables,
  nativeBusinessTables,
  ordinaryAuthorityTables,
  ordinaryBusinessTables
} from "../scripts/control-plane-install-live-evidence.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("packaged ordinary control-plane evidence", () => {
  it("counts every installed business table without treating a service epoch as job demand", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-installed-ordinary-tables-"));
    roots.push(root);
    const database = openNativeRootAdmissionDatabase(join(root, "ordinary.sqlite3"));

    // When
    const actual = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
    database.close();

    // Then
    expect(ordinaryBusinessTables).not.toContain("native_root_ci_service_epochs");
    expect(ordinaryAuthorityTables).not.toContain("native_root_ci_service_epochs");
    expect(actual).toEqual(["native_root_ci_service_epochs", ...ordinaryAuthorityTables].sort());
  });
});

describe("packaged native control-plane evidence", () => {
  it("counts the exact format 8 authority tables", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-installed-native-tables-"));
    roots.push(root);
    const database = createNativeGitBundleDatabase(join(root, "native-idle.sqlite3"));

    // When
    const actual = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
    database.close();

    // Then
    expect(nativeBusinessTables).toEqual([
      "native_project_registration",
      "native_project_root_import",
      "native_project_root_promotion_finalized",
      "native_project_root_promotion_intent"
    ]);
    expect(nativeAuthorityTables).toEqual(["bundle_activation", ...nativeBusinessTables]);
    expect(actual).toEqual([...nativeAuthorityTables].sort());
  });
});
