import { describe, expect, it } from "vitest";
import { localBinPrompt } from "../src/installMode.js";

// Contract: ../../../specs/14-installer-facade.md#installation-modes
describe("recommended interactive installation mode", () => {
  it("keeps DIM managed by mise when the user answers y or accepts the default", () => {
    const prompt = localBinPrompt(true);

    expect(prompt.question).toContain("Keep DIM managed by mise");
    expect(prompt.question).toContain("[Y/n]");
    expect(prompt.exposeOnPath("y")).toBe(false);
    expect(prompt.exposeOnPath("")).toBe(false);
    expect(prompt.exposeOnPath("n")).toBe(true);
  });

  it("exposes DIM directly outside mise when the user answers y or accepts the default", () => {
    const prompt = localBinPrompt(false);

    expect(prompt.question).toContain("Expose DIM");
    expect(prompt.question).toContain("[Y/n]");
    expect(prompt.exposeOnPath("y")).toBe(true);
    expect(prompt.exposeOnPath("")).toBe(true);
    expect(prompt.exposeOnPath("n")).toBe(false);
  });
});
