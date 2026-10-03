import { afterEach, describe, expect, it } from "vitest";

const rendererUrl = new URL("../../../../core/packages/web/src/assets/review-renderer.js", import.meta.url).href;

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = { add: () => undefined, remove: () => undefined };
  readonly dataset: Record<string, string> = {};
  className = "";
  hidden = false;
  textContent = "";
  title = "";
  value = "";

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(): void {}
}

const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
});

describe("review patch rendering", () => {
  it("preserves the exact API patch including blank lines", async () => {
    // Given
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument() });
    const { renderReview } = await import(rendererUrl);
    const elements = reviewElements();
    const patch = "+first\n\n-second\n";

    // When
    renderReview(elements, review(patch));

    // Then
    expect(elements.patchCode.children.map((child) => child.textContent).join("")).toBe(patch);
  });

  it("bounds the DOM node count for a large supported patch without dropping text", async () => {
    // Given
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument() });
    const { renderReview } = await import(rendererUrl);
    const elements = reviewElements();
    const patch = Array.from({ length: 6_000 }, (_, index) => `+line-${index}\n`).join("");

    // When
    renderReview(elements, review(patch));

    // Then
    expect(elements.patchCode.children.length).toBeLessThanOrEqual(5_000);
    expect(elements.patchCode.children.map((child) => child.textContent).join("")).toBe(patch);
  });

  it("offers path breaks at separators without splitting CJK words or changing path text", async () => {
    // Given
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument() });
    const { renderReview } = await import(rendererUrl);
    const elements = reviewElements();
    const path = "docs/日本語_折り返し_確認_中文_路径_确认.txt";
    const fixture = review("+text\n");
    fixture.changes.splice(0, 1, { status: "modified", oldPath: path, newPath: path });

    // When
    renderReview(elements, fixture);

    // Then
    const pathElement = elements.changedPaths.children.at(0)?.children.at(1);
    expect(pathElement).toBeDefined();
    if (pathElement === undefined) throw new Error("review path was not rendered");
    expect(pathElement.children.map((node) => node.textContent).join("")).toBe(path);
    expect(pathElement.children.filter((node) => node.className === "path-break")).toHaveLength(6);
    expect(pathElement.children.some((node) => node.textContent === "折り返し_")).toBe(true);
    expect(pathElement.children.some((node) => node.textContent === "确认.txt")).toBe(true);
  });

  it("shows an explicit error instead of partial evidence above the browser limit", async () => {
    // Given
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument() });
    const { renderReview } = await import(rendererUrl);
    const elements = reviewElements();
    const patch = "\n".repeat(250_001);

    // When
    const result = renderReview(elements, review(patch));

    // Then
    expect(result).toEqual({ complete: false });
    expect(elements.patchCode.children).toHaveLength(0);
    expect(elements.patchRegion.hidden).toBe(true);
    expect(elements.patchError.hidden).toBe(false);
    expect(elements.patchError.textContent).toContain("No partial patch is shown");
  });

  it("scrubs review evidence before a signed-out workspace can be shown again", async () => {
    // Given
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument() });
    const { clearReview, renderReview } = await import(rendererUrl);
    const elements = reviewElements();
    elements.protectedRef.value = "refs/heads/main";
    elements.proposalRef.value = "refs/heads/proposals/workspace-a/change-1";
    elements.requestError.textContent = "retryable error";
    elements.errorDetail.textContent = "retryable error";
    elements.scopeProject.textContent = "project-a";
    elements.scopeReviewer.textContent = "reviewer-a";
    elements.reviewerLabel.textContent = "reviewer-a";
    renderReview(elements, review("+secret evidence\n"));
    elements.reviewView.hidden = false;
    elements.emptyState.hidden = true;
    elements.retryButton.hidden = false;

    // When
    clearReview(elements);
    elements.workspace.hidden = false;

    // Then
    expect(elements.reviewView.hidden).toBe(true);
    expect(elements.emptyState.hidden).toBe(false);
    expect(elements.retryButton.hidden).toBe(true);
    expect([elements.patchCode, elements.metadata, elements.changedPaths, elements.staleReasons]
      .map((element) => element.children.length)).toEqual([0, 0, 0, 0]);
    expect([elements.reviewId, elements.protectedRef, elements.proposalRef, elements.password]
      .map((element) => element.value.length)).toEqual([0, 0, 0, 0]);
    expect([elements.pathCount, elements.reviewTitle, elements.reviewStatus, elements.patchError,
      elements.patchCue, elements.requestError, elements.errorTitle, elements.errorDetail,
      elements.scopeProject, elements.scopeReviewer, elements.reviewerLabel]
      .map((element) => element.textContent.length)).toEqual(Array.from({ length: 11 }, () => 0));
  });
});

function reviewElements() {
  return {
    reviewId: new FakeElement(),
    protectedRef: new FakeElement(),
    proposalRef: new FakeElement(),
    password: new FakeElement(),
    loginButton: new FakeElement(),
    workspace: new FakeElement(),
    reviewerLabel: new FakeElement(),
    scopeProject: new FakeElement(),
    scopeReviewer: new FakeElement(),
    requestError: new FakeElement(),
    retryButton: new FakeElement(),
    emptyState: new FakeElement(),
    loadingState: new FakeElement(),
    errorState: new FakeElement(),
    errorTitle: new FakeElement(),
    errorDetail: new FakeElement(),
    reviewView: new FakeElement(),
    reviewTitle: new FakeElement(),
    reviewStatus: new FakeElement(),
    stalePanel: new FakeElement(),
    staleReasons: new FakeElement(),
    metadata: new FakeElement(),
    pathCount: new FakeElement(),
    changedPaths: new FakeElement(),
    patchCode: new FakeElement(),
    patchError: new FakeElement(),
    patchRegion: new FakeElement(),
    patchCue: new FakeElement(),
    patchThumb: new FakeElement(),
    alertAnnouncer: new FakeElement(),
    statusAnnouncer: new FakeElement(),
    repository: new FakeElement()
  };
}

function fakeDocument() {
  return {
    createElement: () => new FakeElement(),
    createTextNode: (text: string) => {
      const node = new FakeElement();
      node.textContent = text;
      return node;
    }
  };
}

function review(patch: string) {
  return {
    input: {
      status: "pending",
      projectId: "project-a",
      repositoryId: "source",
      protectedRef: "refs/heads/main",
      proposalRef: "refs/heads/work",
      expectedProtectedHead: "a".repeat(40),
      candidateCommit: "b".repeat(40),
      candidateTree: "c".repeat(40),
      policyRevision: "policy-1",
      requiredReviewRevision: "review-1",
      requiredJobSetRevision: "jobs-1",
      workspaceId: "workspace-1",
      reviewId: "d".repeat(64),
      createdAt: "2026-10-03T00:00:00Z",
      patch
    },
    changes: [{ status: "modified", oldPath: "file.txt", newPath: "file.txt" }],
    staleReasons: [],
    requiredReviewerIds: ["reviewer-a"]
  };
}
