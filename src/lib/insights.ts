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

/** Send an input to Playground. JSON object inputs (several columns) stay JSON. */
/** Send an input to the Playground. Multi-column (JSON object) inputs become labelled lines. */
export function openInPlayground(go: ReturnType<typeof useApp>["go"], input: string) {
  let text = input;
  if (input.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(input) as Record<string, unknown>;
      text = Object.entries(obj)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");
    } catch {
      /* plain text */
    }
  }
  handoff.set({ text, asJson: false });
  go({ page: "quick" });
}
