import { describe, expect, it } from "vitest";

const patchPositionUrl = new URL("../../../../core/packages/web/src/assets/patch-position.js", import.meta.url).href;

describe("patch horizontal position", () => {
  it("hides the position track when the patch fits", async () => {
    // Given
    const { updatePatchPosition } = await import(patchPositionUrl);
    const elements = patchElements({ clientWidth: 100, scrollLeft: 0, scrollWidth: 100 });

    // When
    updatePatchPosition(elements);

    // Then
    expect(elements.patchCue.textContent).toBe("Patch fits without horizontal scrolling.");
    expect(elements.patchTrack.hidden).toBe(true);
  });

  it("describes an overflowing patch at the start", async () => {
    // Given
    const { updatePatchPosition } = await import(patchPositionUrl);
    const elements = patchElements({ clientWidth: 100, scrollLeft: 0, scrollWidth: 200 });

    // When
    updatePatchPosition(elements);

    // Then
    expect(elements.patchCue.textContent).toBe("Patch is at the start.");
    expect(elements.patchTrack.hidden).toBe(false);
  });

  it("describes an overflowing patch in the middle", async () => {
    // Given
    const { updatePatchPosition } = await import(patchPositionUrl);
    const elements = patchElements({ clientWidth: 100, scrollLeft: 50, scrollWidth: 200 });

    // When
    updatePatchPosition(elements);

    // Then
    expect(elements.patchCue.textContent).toBe("Patch is in the middle.");
    expect(elements.patchTrack.hidden).toBe(false);
  });

  it("describes an overflowing patch at the end", async () => {
    // Given
    const { updatePatchPosition } = await import(patchPositionUrl);
    const elements = patchElements({ clientWidth: 100, scrollLeft: 100, scrollWidth: 200 });

    // When
    updatePatchPosition(elements);

    // Then
    expect(elements.patchCue.textContent).toBe("Patch is at the end.");
    expect(elements.patchTrack.hidden).toBe(false);
  });
});

function patchElements(region: { readonly clientWidth: number; readonly scrollLeft: number; readonly scrollWidth: number }) {
  return {
    patchCue: { textContent: "" },
    patchRegion: region,
    patchThumb: { style: { inlineSize: "", transform: "" } },
    patchTrack: { hidden: false }
  };
}
