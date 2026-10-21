import { expect, it } from "vitest";
import { controlPlanePlugin, dimWorkflowCompiler } from "../../../../packages/control-plane/plugins/ci-workflows/src/index.js";
import { requireWorkflowCompiler, WORKFLOW_COMPILER_EXTENSION } from "../../../../packages/contracts/ci/src/workflow-plugin-api.js";
it("publishes an installed language capability without making it a core control-plane field", async () => {
  const prepared = await controlPlanePlugin.configure({});
  expect(prepared.extensions?.map(({ kind, name }) => ({ kind, name }))).toEqual([{ kind: WORKFLOW_COMPILER_EXTENSION, name: "dim" }]);
  expect(requireWorkflowCompiler(prepared.extensions ?? [])).toBe(dimWorkflowCompiler);
  expect(() => requireWorkflowCompiler([])).toThrow(/unavailable/);
});
