import { describe, expect, it } from "vitest";
import { localBinPrompt } from "../src/installMode.js";

describe("localBinPrompt", () => {
  it.each(["", "y", "yes", "Y"])("keeps the recommended proxied mode under mise for %j", (answer) => {
    const prompt = localBinPrompt(true);

    expect(prompt.question).toBe("Keep DIM managed by mise without a ~/.local/bin/dim symlink? [Y/n]: ");
    expect(prompt.exposeOnPath(answer)).toBe(false);
  });

  it.each(["n", "no", "N"])("selects direct mode under mise for %j", (answer) => {
    expect(localBinPrompt(true).exposeOnPath(answer)).toBe(true);
  });

  it.each(["", "y", "yes", "Y"])("keeps the recommended direct mode outside mise for %j", (answer) => {
    const prompt = localBinPrompt(false);

    expect(prompt.question).toBe("Expose DIM through a ~/.local/bin/dim symlink? [Y/n]: ");
    expect(prompt.exposeOnPath(answer)).toBe(true);
  });

  it.each(["n", "no", "N"])("selects proxied mode outside mise for %j", (answer) => {
    expect(localBinPrompt(false).exposeOnPath(answer)).toBe(false);
  });
});
