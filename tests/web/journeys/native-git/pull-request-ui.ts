import assert from "node:assert/strict";
import type { Page, Dialog } from "playwright-core";
import { ReviewUI } from "./ui.js";

/** Screen-specific details stay here so a redesigned PR screen changes one adapter. */
export class PullRequestUI extends ReviewUI {
  constructor(private readonly browserPage: Page) { super(browserPage); }
  private get detail() { return this.browserPage.getByRole("region", { name: "Pull request details", exact: true }); }

  async createPullRequest(proposalRef: string, title: string) {
    await this.browserPage.getByText("Create pull request", { exact: true }).first().click();
    await this.browserPage.getByLabel("Pull request title", { exact: true }).fill(title);
    await this.browserPage.getByLabel("Pull request description", { exact: true }).fill("Review the workspace configuration change before merging.");
    await this.browserPage.getByLabel("Source ref", { exact: true }).fill(proposalRef);
    await this.browserPage.getByLabel("Target ref", { exact: true }).fill("main");
    await this.browserPage.getByRole("button", { name: "Create pull request", exact: true }).click();
    await this.detail.getByRole("heading", { name: title, exact: true }).waitFor();
    await this.detail.getByRole("region", { name: "Diff for .dim/review-boundary.json", exact: true }).waitFor();
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
  }

  async approveRevision() {
    const approve = this.detail.getByRole("button", { name: "Approve revision", exact: true });
    await approve.waitFor();
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

  async refreshAfterPush() {
    await this.detail.getByRole("button", { name: "Refresh pull request", exact: true }).click();
    await this.detail.getByText(/Revision 2 ·/).waitFor();
    await this.detail.getByText(/Outdated revision/).first().waitFor();
    await this.detail.getByText("Check the configuration boundary before merge.", { exact: true }).waitFor();
    const oldInline = this.detail.getByRole("article").filter({ hasText: "This field change needs the reviewer policy." });
    await oldInline.getByText(/Outdated revision/).waitFor();
    const merge = this.detail.getByRole("button", { name: "Merge pull request", exact: true });
    assert.equal(await merge.isDisabled(), true, "approval for the previous revision must not enable merging a new commit");
  }

  async mergePullRequest(title: string) {
    const merge = this.detail.getByRole("button", { name: "Merge pull request", exact: true });
    assert.equal(await merge.isEnabled(), true, "the reviewed current revision must be mergeable");
    const confirm = (dialog: Dialog) => dialog.accept();
    this.browserPage.on("dialog", confirm);
    try {
      await merge.click();
      await this.browserPage.getByRole("navigation", { name: "Pull requests", exact: true }).getByRole("button", { name: `${title} · merged`, exact: true }).waitFor();
    } finally { this.browserPage.off("dialog", confirm); }
  }
}
