import { expect, it } from "vitest";
import { MissingRecordError, type WorkspaceService } from "@slop-lab/dim-core/workspace";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
import { checkWorkspace } from "../../../../plugin-workspace-check/src/index.js";

type Operations = Parameters<typeof checkWorkspace>[0];
function fixture(failure?: "create" | "recreate") {
  let present = false, recreated = false;
  const discarded: string[] = [];
  const workspace = workspaceRecord();
  const service: Operations = {
    async create(input) { present = true; workspace.name = input.name; if (failure === "create") throw new Error("partial creation failed"); return workspace; },
    async start() { return workspace; }, async stop() { return workspace; },
    async recreate() { recreated = true; return workspace; },
    async exec() { return failure === "recreate" && recreated ? 1 : 0; },
    async discard(name) { if (!present) throw new MissingRecordError(`workspace '${name}' is absent`); present = false; discarded.push(name); }
  } satisfies Pick<WorkspaceService, keyof Operations>;
  return { service, discarded, present: () => present };
}

it("checks persistence through restart and recreation, then removes only its generated workspace", async () => {
  const test = fixture();
  const result = await checkWorkspace(test.service, { source: "https://example.com/app.git" });
  expect(result.checks).toEqual(["restart", "recreate"]);
  expect(result.workspace).toMatch(/^check-[0-9a-f-]{36}$/);
  expect(test.discarded).toEqual([result.workspace]);
  expect(test.present()).toBe(false);
});
it.each(["create", "recreate"] as const)("also cleans partial or failed %s workspaces", async (failure) => {
  const test = fixture(failure);
  await expect(checkWorkspace(test.service, { source: "https://example.com/app.git" })).rejects.toThrow(failure === "create" ? /partial creation/ : /lost persistent data/);
  expect(test.discarded).toHaveLength(1);
  expect(test.present()).toBe(false);
});
