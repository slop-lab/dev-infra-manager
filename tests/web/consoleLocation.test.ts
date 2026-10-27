import { describe, expect, it } from "vitest";
import { hrefLocation, parseLocation } from "../../packages/web/core/src/assets/console-location.js";

describe("console object locations", () => {
  it("round trips host and object identities without treating delimiters as navigation", () => {
    const path = ["workspaces", "remote host", "workspace-id", "tools"];
    expect(parseLocation(hrefLocation(path))).toEqual(path);
  });
  it("distinguishes an empty starting location from an unavailable route", () => {
    expect(parseLocation("")).toEqual([]);
    expect(parseLocation("#/not-installed/object")).toEqual(["not-installed", "object"]);
  });
  it.each(["#/%", "#/features/%2fadmin", "#/workspaces/%00", "#/a//b", `#/${"x".repeat(257)}`])("rejects malformed location %s", (hash) => {
    expect(parseLocation(hash)).toBeNull();
  });
});
