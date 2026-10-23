import { expect, it } from "vitest";
import { endpointFamily, safeErrorCategory, safeLabel } from "./trace.ts";

it("retains useful endpoint families without credentials, query strings or arbitrary paths", () => {
  expect(endpointFamily("http://user:secret@localhost/v1/extensions/native-git/operations/private-token?password=secret")).toBe("/v1/extensions/native-git/operations/*");
  expect(endpointFamily("http://localhost/v1/session?password=secret")).toBe("/v1/session/*");
  expect(endpointFamily("http://localhost/v1/operations/private-token")).toBe("/v1/operations/*");
  expect(endpointFamily("http://localhost/v1/extensions/secret-password/operations/secret")).toBe("/v1/extensions/*");
  expect(endpointFamily("http://localhost/v1/secret-password")).toBe("other");
  expect(endpointFamily("http://localhost/private-token?key=secret")).toBe("other");
  expect(endpointFamily("invalid secret")).toBe("other");
});

it("requires fixed readable labels instead of arbitrary diagnostic content", () => {
  expect(safeLabel("Open review")).toBe("Open review");
  expect(() => safeLabel('{"password":"secret"}')).toThrow("fixed descriptive names");
  expect(() => safeLabel("response\nsecret")).toThrow("fixed descriptive names");
});

it("retains only allowlisted error categories without names or messages from external code", () => {
  expect(safeErrorCategory(new TypeError("private password"))).toBe("TypeError");
  const error = new Error("private response body");
  error.name = "TimeoutError";
  expect(safeErrorCategory(error)).toBe("TimeoutError");
  error.name = "private credential";
  expect(safeErrorCategory(error)).toBe("UnknownError");
  expect(safeErrorCategory({ name: "Error", message: "private response" })).toBe("UnknownError");
});
