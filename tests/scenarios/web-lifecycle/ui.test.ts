import { describe, expect, it } from "vitest";
import { disclosureNeedsOpen } from "./ui.js";

describe("disclosureNeedsOpen", () => {
  it("Given open settings, when recreate needs its control, then the disclosure remains open", () => {
    expect(disclosureNeedsOpen(true)).toBe(false);
  });

  it("Given closed settings, when recreate needs its control, then the disclosure must open", () => {
    expect(disclosureNeedsOpen(false)).toBe(true);
  });
});
