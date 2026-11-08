import { expect, it } from "vitest";
import { authenticationBoundaryObservation } from "./scenario.js";

it("retains a bounded HTTP status or transport code without copying arbitrary error details", () => {
  expect(authenticationBoundaryObservation(new Error("shared ingress must reach the credential boundary (expected HTTP 401, received 503)"))).toBe("HTTP 503");
  const transport = Object.assign(new Error("request to https://user:private@example.test/?token=private failed"), { code: "ECONNREFUSED" });
  expect(authenticationBoundaryObservation(transport)).toBe("ECONNREFUSED");
  expect(authenticationBoundaryObservation(new Error(transport.message))).toBe("request failed");
  expect(authenticationBoundaryObservation(new DOMException("private details", "TimeoutError"))).toBe("request timeout or cancellation");
});
