export function updatePatchPosition(elements) {
  const maximum = elements.patchRegion.scrollWidth - elements.patchRegion.clientWidth;
  const fits = maximum <= 0;
  const progress = fits ? 0 : elements.patchRegion.scrollLeft / maximum;
  elements.patchCue.textContent = fits ? "Patch fits without horizontal scrolling." : progress <= 0.01 ? "Patch is at the start." : progress >= 0.99 ? "Patch is at the end." : "Patch is in the middle.";
  elements.patchTrack.hidden = fits;
  const ratio = fits ? 1 : elements.patchRegion.clientWidth / elements.patchRegion.scrollWidth;
  elements.patchThumb.style.inlineSize = `${Math.max(ratio * 100, 8)}%`;
  elements.patchThumb.style.transform = `translateX(${progress * (100 / Math.max(ratio, 0.08) - 100)}%)`;
}
