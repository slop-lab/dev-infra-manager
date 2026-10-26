import { createMutationReconciliation } from "../../../../packages/web/plugins/llm-router/src/assets/mutation-reconciliation.js";
import { expect, it } from "vitest";

it("keeps a newer unknown mutation locked when an older authoritative read completes", () => {
  const reconciliation = createMutationReconciliation();
  const staleRead = reconciliation.beginRead();
  reconciliation.unknown("route.upsert:default");

  expect(reconciliation.reconcile(staleRead, "route.upsert:default", false)).toBe("unknown");
  expect(reconciliation.locked("route.upsert:default")).toBe(true);

  const freshRead = reconciliation.beginRead();
  expect(reconciliation.reconcile(freshRead, "route.upsert:default", false)).toBeUndefined();
  expect(reconciliation.locked("route.upsert:default")).toBe(false);
});

it("preserves unknown locks across edits and retains committed mutations as accepted", () => {
  const reconciliation = createMutationReconciliation();
  reconciliation.unknown("account.rename:account-one");
  reconciliation.edit("account.rename:account-one");

  expect(reconciliation.locked("account.rename:account-one")).toBe(true);
  const freshRead = reconciliation.beginRead();
  expect(reconciliation.reconcile(freshRead, "account.rename:account-one", true)).toBe("accepted");
  reconciliation.edit("account.rename:account-one");
  expect(reconciliation.locked("account.rename:account-one")).toBe(false);
});
