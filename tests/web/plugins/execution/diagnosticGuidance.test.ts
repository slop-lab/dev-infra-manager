import { expect, it } from "vitest";
import { admissionGuidance, completionGuidance } from "../../../../packages/web/plugins/execution/src/assets/panel.js";

it("maps bounded Git admission diagnostics to fixed operator guidance", () => {
  expect(admissionGuidance({ phase: "authorize", code: "timeout" })).toContain("reconnect this controller");
  expect(admissionGuidance({ phase: "candidate-read", code: "unavailable" })).toContain("Git proof is unavailable");
  expect(admissionGuidance({ phase: "candidate-read", code: "stale" })).toContain("Resolve a fresh review");
});

it("distinguishes executor failures from guest exits without exposing executor codes", () => {
  expect(completionGuidance({ kind: "executor-failure", code: "private-backend-detail" })).toBe("Execution infrastructure failed before a guest result was available. Inspect worker capacity and retry.");
  expect(completionGuidance({ kind: "exited", exitCode: 23 })).toBe("Guest command exited with code 23. Inspect the captured guest logs before retrying.");
});
