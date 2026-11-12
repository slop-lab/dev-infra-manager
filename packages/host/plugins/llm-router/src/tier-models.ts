/** Host-side validation of the explicitly selected workspace tier mapping. */
type Model = { id: string; api: "responses" | "chat" };
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid DIM tier mapping");
  return value as Record<string, unknown>;
}
export type TierModels = { quick: string; standard: string; deep: string };
export function parseTierModels(value: unknown): TierModels {
  const tiers = record(value);
  if (Object.keys(tiers).length !== 3 || !["quick", "standard", "deep"].every((key) =>
    typeof tiers[key] === "string" && (tiers[key] as string).length > 0 && (tiers[key] as string).length <= 200
      && !/[\s\x00-\x1f\x7f]/.test(tiers[key] as string))) {
    throw new Error("DIM tiers must contain exactly quick, standard and deep model IDs");
  }
  return { quick: tiers.quick as string, standard: tiers.standard as string, deep: tiers.deep as string };
}
export function validateTierModels(tiers: TierModels, models: readonly Model[]): void {
  for (const [tier, id] of Object.entries(tiers)) {
    const target = models.find((model) => model.id === id);
    if (!target || target.api !== "chat") throw new Error(`DIM tier '${tier}' requires an available chat route model`);
    if (models.some((model) => model.id === tier)) throw new Error(`DIM tier alias '${tier}' collides with a route model`);
  }
}
