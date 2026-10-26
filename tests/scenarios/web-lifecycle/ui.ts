import type { Locator, Page } from "playwright-core";

export function disclosureNeedsOpen(open: boolean): boolean {
  return !open;
}

export class WorkspaceUi {
  constructor(private readonly page: Page, private readonly host = "fixture") {}

  async signIn(username: string, password: string): Promise<void> {
    await this.page.getByLabel("Username").fill(username);
    await this.page.getByLabel("Password").fill(password);
    await this.page.getByRole("button", { name: "Sign in" }).click();
    await this.page.locator("#operations-panel").waitFor({ state: "visible" });
    await this.page.getByText("Workspaces refreshed.", { exact: true }).waitFor();
  }

  async openCreate(): Promise<Locator> {
    await this.page.getByRole("button", { name: `New workspace on ${this.host}`, exact: true }).click();
    return this.page.getByRole("form", { name: `New workspace on ${this.host}`, exact: true });
  }

  async createWorkspace(input: { readonly source: string; readonly name: string; readonly image: string }): Promise<Locator> {
    const form = await this.openCreate();
    await form.getByLabel(`Git URL or dim://PROJECT on ${this.host}`, { exact: true }).fill(input.source);
    await form.getByLabel(`Workspace name on ${this.host}`, { exact: true }).fill(input.name);
    await form.getByText("Advanced options", { exact: true }).click();
    await form.getByLabel(`Runtime on ${this.host}`, { exact: true }).fill("container");
    await form.getByLabel(`Image (optional) on ${this.host}`, { exact: true }).fill(input.image);
    await form.getByLabel(`CPU limit (optional) on ${this.host}`, { exact: true }).fill("1");
    await form.getByLabel(`Memory limit (optional) on ${this.host}`, { exact: true }).fill("2g");
    await form.getByLabel(`PID limit (optional) on ${this.host}`, { exact: true }).fill("512");
    await form.getByRole("button", { name: `Create workspace on ${this.host}`, exact: true }).click();
    const row = this.row(input.name);
    await row.waitFor();
    return row;
  }

  row(name: string): Locator {
    return this.page.locator(".workspace-row").filter({ has: this.page.getByRole("heading", { name, exact: true }) });
  }

  async action(name: string, action: "start" | "stop" | "restart" | "recreate"): Promise<void> {
    const row = this.row(name);
    if (action === "recreate") {
      const settings = row.locator(".workspace-settings");
      const open = await settings.evaluate((element) => element instanceof HTMLDetailsElement && element.open);
      if (disclosureNeedsOpen(open)) await row.getByText(`Settings for ${name}`, { exact: true }).click();
    }
    await row.getByRole("button", { name: `${action} ${name}`, exact: true }).click();
    await row.getByText(`${name}: current state refreshed after ${action}.`, { exact: true }).waitFor();
  }

  async rejectInvalidSource(source: string, name: string): Promise<"client" | "server"> {
    const form = await this.openCreate();
    await form.getByLabel(`Git URL or dim://PROJECT on ${this.host}`, { exact: true }).fill(source);
    await form.getByLabel(`Workspace name on ${this.host}`, { exact: true }).fill(name);
    const valid = await form.evaluate((element) => element instanceof HTMLFormElement && element.checkValidity());
    const submit = form.getByRole("button", { name: `Create workspace on ${this.host}`, exact: true });
    if (!valid) {
      await submit.click();
      return "client";
    }
    const response = this.page.waitForResponse((candidate) => candidate.request().method() === "POST"
      && candidate.url().endsWith(`/v1/operations/hosts/${this.host}/workspaces/create`));
    await submit.click();
    if ((await response).status() !== 400) throw new TypeError("invalid source did not receive an HTTP 400 response");
    return "server";
  }

  async resources(name: string, values: { readonly cpu: string; readonly memory: string; readonly pids: string }): Promise<void> {
    const row = this.row(name);
    const settings = row.locator(".workspace-settings");
    const open = await settings.evaluate((element) => element instanceof HTMLDetailsElement && element.open);
    if (!open) await row.getByText(`Settings for ${name}`, { exact: true }).click();
    await row.getByLabel(`CPUs for ${name}`, { exact: true }).fill(values.cpu);
    await row.getByLabel(`Memory for ${name}`, { exact: true }).fill(values.memory);
    await row.getByLabel(`PIDs for ${name}`, { exact: true }).fill(values.pids);
    await row.getByRole("button", { name: `Apply resources for ${name}`, exact: true }).click();
    await row.getByText(`${name}: resource limits refreshed from the host.`, { exact: true }).waitFor();
  }

  async cancelDiscard(name: string): Promise<void> {
    const row = this.row(name);
    await row.getByRole("button", { name: `discard ${name}`, exact: true }).click();
    await row.getByRole("button", { name: `Keep ${name}`, exact: true }).click();
  }

  async discard(name: string): Promise<void> {
    const row = this.row(name);
    await row.getByRole("button", { name: `discard ${name}`, exact: true }).click();
    await row.getByRole("button", { name: `Discard ${name} and its data`, exact: true }).click();
    await row.waitFor({ state: "detached" });
  }
}
