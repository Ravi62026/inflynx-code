/**
 * Metering policy — the single place that turns a USD cost into credit units. Kept out of the
 * server entry so it is unit-testable and the "what does a turn cost" rule lives in one spot.
 */
export function creditsForCostUsd(usd: number, ratePerUsd: number = Number(process.env.INFLYNX_CREDITS_PER_USD || "100")): number {
  const rate = Number.isFinite(ratePerUsd) && ratePerUsd > 0 ? ratePerUsd : 100;
  return Math.max(1, Math.ceil(Math.max(0, usd) * rate));
}
