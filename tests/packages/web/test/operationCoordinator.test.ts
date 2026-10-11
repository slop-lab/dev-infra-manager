import { describe, expect, it } from "vitest";

const coordinatorUrl = new URL("../../../../core/packages/web/src/assets/operation-coordinator.js", import.meta.url).href;

describe("reviewer operation coordination", () => {
  it("allows only the newest operation to commit", async () => {
    // Given
    const { createOperationCoordinator } = await import(coordinatorUrl);
    const coordinator = createOperationCoordinator();
    const first = coordinator.start();

    // When
    const second = coordinator.start();

    // Then
    expect(first.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });

  it("makes logout supersede a pending review operation", async () => {
    // Given
    const { createOperationCoordinator } = await import(coordinatorUrl);
    const coordinator = createOperationCoordinator();
    const pendingReview = coordinator.start();

    // When
    const logout = coordinator.start();

    // Then
    expect(pendingReview.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(pendingReview)).toBe(false);
    expect(coordinator.isCurrent(logout)).toBe(true);
  });
});
