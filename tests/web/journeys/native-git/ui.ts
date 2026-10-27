import assert from "node:assert/strict";
import type { Page } from "playwright-core";

/** Replace this small adapter when navigation/forms change. These selectors are
 * implementation details, not a requirement to retain today's interface. */
export class ReviewUI {
  constructor(private readonly page: Page) {}

  async signIn(origin: string, username: string, password: string) {
    await this.page.goto(origin);
    await this.page.getByLabel("Username", { exact: true }).fill(username);
    await this.page.getByLabel("Password", { exact: true }).fill(password);
    await this.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await this.page.getByRole("link", { name: "Git review", exact: true }).waitFor();
  }

  async openReviews(projectId?: string, repositoryId?: string) {
    await this.page.getByRole("link", { name: "Git review", exact: true }).click();
    if (projectId) await this.page.getByLabel("Project", { exact: true }).selectOption(projectId);
    if (repositoryId) await this.page.getByLabel("Repository", { exact: true }).selectOption(repositoryId);
  }

  async createProject(projectId: string) {
    await this.page.getByText("New project", { exact: true }).click();
    const form = this.page.getByRole("form", { name: "New managed project", exact: true });
    await form.getByLabel("New project ID", { exact: true }).fill(projectId);
    await form.getByRole("button", { name: "Create project", exact: true }).click();
    await this.waitForSelection("Project", projectId);
  }

  async importRepository(repositoryId: string, url: string) {
    await this.page.getByText("Import repository", { exact: true }).first().click();
    const form = this.page.getByRole("form", { name: "Import public Git repository", exact: true });
    await form.getByLabel("New repository ID", { exact: true }).fill(repositoryId);
    await form.getByLabel("Public HTTPS Git URL", { exact: true }).fill(url);
    await form.getByRole("button", { name: "Import repository", exact: true }).click();
    await this.waitForSelection("Repository", repositoryId);
  }

  private async waitForSelection(label: string, value: string) {
    await this.page.waitForFunction(({ label, value }) => {
      const control = document.querySelector(`select[aria-label="${label}"]`);
      return control instanceof HTMLSelectElement && control.value === value;
    }, { label, value });
  }

  private async openAdvanced() {
    await this.page.getByRole("heading", { name: "Merge a branch", exact: true }).waitFor();
    const section = this.page.locator("details").filter({ has: this.page.locator("summary").filter({ hasText: /^Advanced: exact reviews and upstream sync$/ }) });
    if (!await section.evaluate(node => node instanceof HTMLDetailsElement && node.open)) await section.locator("summary").first().click();
  }

  async inspectProposal(proposalRef: string) {
    await this.openAdvanced();
    await this.page.getByLabel("Proposal ref", { exact: true }).fill(proposalRef);
    await this.page.getByRole("button", { name: "Resolve proposal review", exact: true }).click();
    await this.page.getByRole("heading", { name: "Changed files", exact: true }).waitFor();
    await this.page.getByRole("listitem").filter({ hasText: ".dim/review-boundary.json" }).first().waitFor();
  }

  async openPendingProposal(proposalRef: string) {
    await this.openAdvanced();
    await this.page.getByRole("button", { name: "Refresh reviews", exact: true }).click();
    const row = this.page.getByRole("row").filter({ has: this.page.getByRole("cell", { name: proposalRef, exact: true }) });
    await row.getByRole("button", { name: "Open review", exact: true }).click();
    await this.page.getByRole("heading", { name: "Changed files", exact: true }).waitFor();
    await this.page.getByRole("listitem").filter({ hasText: ".dim/review-boundary.json" }).first().waitFor();
  }

  async expectReviewerAccessRequired() {
    const approve = this.page.getByRole("button", { name: "Approve exact candidate", exact: true });
    await approve.waitFor();
    assert.equal(await approve.isDisabled(), true, "default operator must not silently gain reviewer access");
    await this.page.getByRole("button", { name: "Configure review access", exact: true }).waitFor();
  }

  async grantOwnReviewerRole(username: string, password: string) {
    await this.page.getByRole("button", { name: "Configure review access", exact: true }).click();
    const dialog = this.page.getByRole("dialog", { name: "Account & access", exact: true });
    const row = dialog.getByRole("row").filter({ has: this.page.getByRole("cell", { name: username, exact: true }) });
    await row.getByRole("button", { name: "Edit roles", exact: true }).click();
    const form = dialog.getByRole("form", { name: "Manage browser account", exact: true });
    await form.getByLabel("Grant reviewer", { exact: true }).check();
    await form.getByLabel("Your current password", { exact: true }).fill(password);
    await form.getByRole("button", { name: "Save account", exact: true }).click();
    await dialog.getByRole("button", { name: "Sign in again", exact: true }).click();
  }

  async approveAndPromote() {
    const approve = this.page.getByRole("button", { name: "Approve exact candidate", exact: true });
    assert.equal(await approve.isEnabled(), true, "reviewer can approve the inspected candidate after signing in again");
    this.page.once("dialog", (dialog) => dialog.accept()); await approve.click();
    const promote = this.page.getByRole("button", { name: "Promote protected ref", exact: true });
    await promote.waitFor();
    this.page.once("dialog", (dialog) => dialog.accept()); await promote.click();
    await this.page.getByText(/Protected ref promotion accepted/).waitFor();
  }
}
