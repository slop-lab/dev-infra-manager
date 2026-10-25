import assert from "node:assert/strict";
import { join } from "node:path";
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

  async mergePullRequest(title: string, evidenceDirectory?: string) {
    const merge = this.detail.getByRole("button", { name: "Merge pull request", exact: true });
    assert.equal(await merge.isEnabled(), true, "the reviewed current revision must be mergeable");
    let mergeRequests = 0;
    let confirmedPullRequest: object | undefined;
    const mergeEndpoint = /\/v1\/extensions\/native-git\/operations\/pull-requests\.merge$/;
    const refreshEndpoint = /\/v1\/extensions\/native-git\/operations\/pull-requests\.refresh$/;
    const countMerge = (request: { url(): string }) => { if (mergeEndpoint.test(request.url())) mergeRequests += 1; };
    this.browserPage.on("request", countMerge);
    await this.browserPage.route(mergeEndpoint, async (route) => {
      const requestBody: unknown = route.request().postDataJSON();
      assert(requestBody !== null && typeof requestBody === "object" && "expectedVersion" in requestBody && typeof requestBody.expectedVersion === "number",
        "merge request must pin the selected pull request version");
      const response = await route.fetch();
      const result: unknown = await response.json();
      assert(result !== null && typeof result === "object" && "pullRequest" in result && "refreshPending" in result,
        "merge operation must return the accepted promotion and pull request refresh result");
      const pullRequest = result.pullRequest;
      assert(pullRequest !== null && typeof pullRequest === "object" && "state" in pullRequest && "version" in pullRequest && typeof pullRequest.version === "number",
        "merge operation must return a pull request");
      confirmedPullRequest = pullRequest;
      await route.fulfill({ response, json: { ...result, pullRequest: { ...pullRequest, state: "open", version: requestBody.expectedVersion }, refreshPending: true } });
    }, { times: 1 });
    const confirm = (dialog: Dialog) => dialog.accept();
    this.browserPage.on("dialog", confirm);
    try {
      await merge.click();
      await this.detail.getByText("Merge accepted. Refresh the pull request to confirm its recorded state.", { exact: true }).waitFor();
      assert.equal(await merge.isDisabled(), true, "an accepted merge awaiting refresh must not be submitted again");
      assert.equal(await this.browserPage.getByRole("navigation", { name: "Pull requests", exact: true }).getByRole("button", { name: `${title} · merged`, exact: true }).count(), 0,
        "the accepted receipt must not falsely present an unconfirmed refreshed state");
      await merge.dispatchEvent("click");
      assert.equal(mergeRequests, 1, "the disabled accepted merge must not issue a duplicate request");
      if (evidenceDirectory) {
        await this.browserPage.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
        for (const width of [375, 768, 1280]) {
          await this.browserPage.setViewportSize({ width, height: 1000 });
          await this.detail.screenshot({ path: join(evidenceDirectory, `refresh-pending-${width}.png`), animations: "disabled" });
        }
        await this.browserPage.setViewportSize({ width: 1440, height: 1000 });
      }
      await this.browserPage.route(refreshEndpoint, async (route) => {
        assert(confirmedPullRequest, "the accepted merge response must retain the confirmed pull request for explicit refresh");
        await route.fulfill({ json: confirmedPullRequest });
      }, { times: 1 });
      await this.detail.getByRole("button", { name: "Refresh pull request", exact: true }).click();
      await this.browserPage.getByRole("navigation", { name: "Pull requests", exact: true }).getByRole("button", { name: `${title} · merged`, exact: true }).waitFor();
    } finally {
      this.browserPage.off("dialog", confirm);
      this.browserPage.off("request", countMerge);
    }
  }
}
