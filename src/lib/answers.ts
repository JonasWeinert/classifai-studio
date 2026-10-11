// Flat views of an answer: how sure the model is, and the cells it becomes in a CSV or dataset.
import { headline } from "./questionDraft";
import type { AnyAnswer } from "./types";

/** Below this, an answer counts as unsure. */
export const UNSURE = 0.6;

/** How sure the model is, 0.5–1 for yes/no and pick-any, the normalized confidence otherwise (0 = guessing, 1 = certain). */
export function certainty(a: AnyAnswer): number {
  switch (a.type) {
    case "noul":
      return Math.max(a.noul, 1 - a.noul);
    case "multi": {
      const ps = Object.values(a.probabilities);
      return ps.length ? Math.min(...ps.map((p) => Math.max(p, 1 - p))) : 1;
    }
    case "text":
      // A written answer has no probability; it is never "unsure".
      return 1;
    default:
      return a.confidence;
  }
}

/** The chance the model gives its own answer — the number on the highlighted bar, which is what people read. */
export function topChance(a: AnyAnswer): number {
  if (a.type === "noul" || a.type === "multi" || a.type === "text") return certainty(a);
  // A scale's headline is the level nearest the expected value; show that level's chance.
  if (a.type === "score") return a.probabilities[String(Math.round(a.score))] ?? a.confidence;
  const ps = Object.values(a.probabilities);
  return ps.length ? Math.max(...ps) : a.confidence;
}

const STOP = new Set("a an the this that these those is are was were be does do did should would could can will which what who whom whose how why when where of for to in on at by with about from it its there any all some message text entry".split(" "));

/** A short column name for a question: "How frustrated is the customer?" -> "frustrated_customer". */
export function shortColumnName(title: string, fallback: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  return words.slice(0, 3).join("_") || fallback;
}

/** Column names for one question: its answer and a probability column. */
export function answerColumns(id: string, kind: AnyAnswer["type"] | undefined): [string, string] {
  return [id, kind === "noul" ? `${id} p(yes)` : `${id} confidence`];
}

/** The answer and its probability (P(yes) for yes/no, certainty otherwise), as text. */
export function answerCells(a: AnyAnswer | undefined): [string, string] {
  if (!a) return ["", ""];
  if (a.type === "text") return [a.text, ""];
  return [headline(a), (a.type === "noul" ? a.noul : certainty(a)).toFixed(3)];
}
