// Small helpers shared by experiment and dataset pages.
import { handoff } from "./handoff";
import type { useApp } from "./app";

export function kappaWord(k: number) {
  if (k < 0) return "poor";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

/** Send an input to Quick Check. JSON object inputs (several columns) stay JSON. */
export function openInQuickCheck(go: ReturnType<typeof useApp>["go"], input: string) {
  let asJson = false;
  if (input.trim().startsWith("{")) {
    try {
      JSON.parse(input);
      asJson = true;
    } catch {
      /* plain text */
    }
  }
  handoff.set({ text: input, asJson });
  go({ page: "quick" });
}
