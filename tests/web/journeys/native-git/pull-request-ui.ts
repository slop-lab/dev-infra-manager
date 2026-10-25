import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page, Dialog } from "playwright-core";
import { ReviewUI } from "./ui.js";

/** Screen-specific details stay here so a redesigned PR screen changes one adapter. */
export class PullRequestUI extends ReviewUI {
  constructor(private readonly browserPage: Page) { super(browserPage); }
  private get detail() { return this.browserPage.getByRole("region", { name: "Pull request details", exact: true }); }

  async createPullRequest(proposalRef: string, title: string, expectedPath = ".dim/review-boundary.json") {
    const titleInput = this.browserPage.getByLabel("Pull request title", { exact: true });
    if (!await titleInput.isVisible()) await this.browserPage.locator("summary").filter({ hasText: /^Create pull request$/ }).click();
    await titleInput.fill(title);
    await this.browserPage.getByLabel("Pull request description", { exact: true }).fill("Review the workspace configuration change before merging.");
    await this.browserPage.getByLabel("Source ref", { exact: true }).fill(proposalRef);
    await this.browserPage.getByLabel("Target ref", { exact: true }).fill("main");
    await this.browserPage.getByRole("button", { name: "Create pull request", exact: true }).click();
    await this.detail.getByRole("heading", { name: title, exact: true }).waitFor();
    await this.detail.getByRole("region", { name: `Diff for ${expectedPath}`, exact: true }).waitFor();
  }

  async postComment(body: string, inline = false) {
    if (inline) {
      await this.detail.getByRole("button", { name: "Select head line 1 of .dim/review-boundary.json", exact: true }).click();
      await this.detail.getByRole("button", { name: "Use general comment", exact: true }).waitFor();
    }
    const form = this.detail.getByRole("form", { name: "Add comment", exact: true });
    await form.getByLabel("Comment", { exact: true }).fill(body);
    await form.getByRole("button", { name: "Post comment", exact: true }).click();
    await this.detail.getByText(body, { exact: true }).waitFor();
    await this.detail.getByText("Working…", { exact: true }).waitFor({ state: "hidden" });
  }

  async inspectLineAttribution() {
    await this.detail.getByRole("button", { name: "Blame head line 1 of .dim/review-boundary.json", exact: true }).click();
    await this.detail.getByText(/DIM Journey · [a-f0-9]+ · change reviewed configuration/).waitFor();
    await this.detail.getByText("Working…", { exact: true }).waitFor({ state: "hidden" });
  }

  async approveRevision() {
    const prepare = this.detail.getByRole("button", { name: "Prepare review", exact: true });
    await prepare.waitFor();
    await this.browserPage.waitForFunction(() => {
      const region = document.querySelector('[aria-label="Pull request details"]');
      return [...(region?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "Prepare review" && !button.disabled);
    });
    assert.equal(await prepare.isEnabled(), true, "review preparation must be a standalone reviewer-authorized action");
    await prepare.click();
    const approve = this.detail.getByRole("button", { name: "Approve revision", exact: true });
    await approve.waitFor();
    await this.browserPage.waitForFunction(() => {
      const region = document.querySelector('[aria-label="Pull request details"]');
      return [...(region?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "Approve revision" && !button.disabled);
    });
    assert.equal(await approve.isEnabled(), true, "the current revision must be available to the configured reviewer");
    const confirm = (dialog: Dialog) => dialog.accept();
    this.browserPage.on("dialog", confirm);
    try {
      await approve.click();
      await this.browserPage.waitForFunction(() => {
        const region = document.querySelector('[aria-label="Pull request details"]');
        return [...(region?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "Merge pull request" && !button.disabled);
      });
    } finally { this.browserPage.off("dialog", confirm); }
  }

  async revokeApproval() {
    const revoke = this.detail.getByRole("button", { name: "Revoke approval", exact: true });
    await revoke.waitFor();
    await this.browserPage.waitForFunction(() => {
      const region = document.querySelector('[aria-label="Pull request details"]');
      return [...(region?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "Revoke approval" && !button.disabled);
    });
    assert.equal(await revoke.isEnabled(), true, "the current reviewer must be able to revoke its exact approval");
    const confirm = (dialog: Dialog) => dialog.accept();
    this.browserPage.on("dialog", confirm);
    try {
      await revoke.click();
      await this.detail.getByRole("button", { name: "Approve revision", exact: true }).waitFor();
    } finally { this.browserPage.off("dialog", confirm); }
  }

  async refreshAfterPush(candidate: string) {
    await this.detail.getByRole("button", { name: "Refresh pull request", exact: true }).click();
    const revision = this.detail.getByText(/Revision 2 ·/);
    await revision.waitFor();
    assert.match(await revision.textContent() ?? "", new RegExp(`→ ${candidate.slice(0, 12)}$`), "the refreshed pull request must show the rewritten source commit");
    await this.detail.getByText(/Outdated revision/).first().waitFor();
    await this.detail.getByText("Check the configuration boundary before merge.", { exact: true }).waitFor();
    const oldInline = this.detail.getByRole("article").filter({ hasText: "This field change needs the reviewer policy." });
    await oldInline.getByText(/Outdated revision/).waitFor();
    const merge = this.detail.getByRole("button", { name: "Merge pull request", exact: true });
    const confirm = (dialog: Dialog) => dialog.accept();
    this.browserPage.on("dialog", confirm);
    try {
      await merge.click();
      await this.detail.getByText("Working…", { exact: true }).waitFor({ state: "hidden" });
      await this.detail.getByText("Human review pending · required reviewers: owner", { exact: true }).waitFor();
      await this.detail.getByRole("alert").waitFor();
      assert.equal(await merge.isDisabled(), true, "the failed merge must expose pending evidence instead of reusing the previous revision approval");
    } finally { this.browserPage.off("dialog", confirm); }
  }

  async mergePullRequest(title: string, siblingRef: string, evidenceDirectory?: string) {
    const merge = this.detail.getByRole("button", { name: "Merge pull request", exact: true });
    assert.equal(await merge.isEnabled(), true, "the reviewed current revision must be mergeable");
    let mergeRequests = 0;
    const mergeEndpoint = /\/v1\/extensions\/native-git\/operations\/pull-requests\.merge$/;
    const reviewDetailEndpoint = /\/v1\/extensions\/native-git\/operations\/reviews\.detail$/;
    const countMerge = (request: { url(): string }) => { if (mergeEndpoint.test(request.url())) mergeRequests += 1; };
    const expectLocked = async () => {
      await this.detail.getByText("Merge accepted. Refresh the pull request to confirm its recorded state.", { exact: true }).waitFor();
      const action = this.detail.getByRole("button", { name: "Merge pull request", exact: true });
      assert.equal(await action.isDisabled(), true, "an accepted merge awaiting refresh must remain disabled");
      await action.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("merge action must be a button");
        button.disabled = false; button.click(); button.disabled = true;
      });
      assert.equal(mergeRequests, 1, "the accepted merge callback must reject duplicate submission even if the DOM disabled state is bypassed");
    };
    this.browserPage.on("request", countMerge);
    const confirm = (dialog: Dialog) => dialog.accept();
    this.browserPage.on("dialog", confirm);
    try {
      await merge.click();
      await this.browserPage.route(reviewDetailEndpoint, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary review detail failure"}' }));
      await expectLocked();
      assert.equal(await this.browserPage.getByRole("navigation", { name: "Pull requests", exact: true }).getByRole("button", { name: `${title} · merged`, exact: true }).count(), 0,
        "the accepted receipt must not falsely present an unconfirmed refreshed state");
      await this.detail.getByText("Edit pull request", { exact: true }).click();
      const editedDescription = "Review the workspace configuration change before merging. Accepted merge refresh is still pending.";
      await this.detail.getByLabel("Edit description", { exact: true }).fill(editedDescription);
      await this.detail.getByRole("button", { name: "Save changes", exact: true }).click();
      await this.detail.getByText(editedDescription, { exact: true }).waitFor();
      await expectLocked();
      const pendingComment = "The accepted merge still needs an authoritative refresh.";
      const commentForm = this.detail.getByRole("form", { name: "Add comment", exact: true });
      await commentForm.getByLabel("Comment", { exact: true }).fill(pendingComment);
      await commentForm.getByRole("button", { name: "Post comment", exact: true }).click();
      await this.detail.getByText(pendingComment, { exact: true }).waitFor();
      await expectLocked();
      const siblingTitle = "Review sibling configuration";
      await this.createPullRequest(siblingRef, siblingTitle);
      assert.equal(await this.detail.getByText("Merge accepted. Refresh the pull request to confirm its recorded state.", { exact: true }).count(), 0,
        "accepted merge receipt must stay scoped to its pull request revision");
      await this.browserPage.getByRole("navigation", { name: "Pull requests", exact: true }).getByRole("button", { name: `${title} · open`, exact: true }).click();
      await this.detail.getByRole("heading", { name: title, exact: true }).waitFor();
      await this.detail.getByText(pendingComment, { exact: true }).waitFor();
      await expectLocked();
      if (evidenceDirectory) {
        await this.browserPage.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
        for (const width of [375, 768, 1280]) {
          await this.browserPage.setViewportSize({ width, height: 1000 });
          await this.detail.screenshot({ path: join(evidenceDirectory, `refresh-pending-${width}.png`), animations: "disabled" });
        }
        await this.browserPage.setViewportSize({ width: 1440, height: 1000 });
      }
      await this.detail.getByRole("button", { name: "Refresh pull request", exact: true }).click();
      await this.browserPage.getByRole("navigation", { name: "Pull requests", exact: true }).getByRole("button", { name: `${title} · merged`, exact: true }).waitFor();
    } finally {
      this.browserPage.off("dialog", confirm);
      this.browserPage.off("request", countMerge);
      await this.browserPage.unroute(reviewDetailEndpoint);
    }
  }
}
