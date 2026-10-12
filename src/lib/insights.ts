// Small helpers shared by experiment and dataset pages.

export function kappaWord(k: number) {
  if (k < 0) return "poor";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}
