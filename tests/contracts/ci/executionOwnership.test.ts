import { expect, it } from "vitest";
import * as execution from "../../../packages/contracts/ci/src/execution-protocol.js";
import { assignment, grant } from "./executionFixture.js";

it("owns the legacy DIM execution descriptor and event wire codec", () => {
  const scheduled = assignment();
  const issued = grant(scheduled);

  expect(Reflect.get(execution, "dimExecutionDescriptorSchema")).toBeDefined();
  expect(Reflect.get(execution, "dimReviewJobAvailableEventSchema")).toBeDefined();
  expect(execution.executionDescriptorDigest(issued.descriptor)).toBe(issued.descriptorDigest);
  expect(issued.descriptorDigest).toBe("sha256:3060765dbc61c6763864bc85b9fd1544757863fd275d1b0bce0e3aec2f0ccecb");
  expect(execution.executionEventSchema.parse(scheduled.event)).toEqual(scheduled.event);
  expect(execution.encodeDimReviewJobAvailableEvent(
    execution.decodeDimReviewJobAvailableEvent(scheduled.event),
  )).toEqual(scheduled.event);
});
