// Helpers for ground-truth labels in experiment setup: variant detection, merging and default wording.
import type { TaskKind } from "./types";

/** Spelling-insensitive key: "Billing ", "billing." and "BILLING" all map to "billing". */
export const labelKey = (v: string) => v.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

const YES = new Set(["yes", "y", "true", "1", "ja", "positive", "pos", "x"]);
export const isYesLike = (v: string) => YES.has(v.trim().toLowerCase());

const ADJECTIVE = /(ing|ed|al|ive|ous|able|ible|ful|ic|ent|ant|ary|less|ish|ly)$/;
const human = (col: string) => col.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Default instructions for a question.
 * Yes/no on a yes-like positive: "recurring" → "This is a recurring item.", "spam" → "This is spam.",
 * "is_urgent" → "This is urgent."; otherwise "Priority is high.".
 */
export function defaultInstructions(column: string, kind: TaskKind, positive?: string): string {
  const h = human(column);
  if (kind === "choice") return `What is the ${h.toLowerCase()} of this text?`;
  const p = (positive ?? "").trim();
  if (!p || isYesLike(p)) {
    const m = h.match(/^(is|has|was|contains)\s+(.+)$/i);
    if (m) return `This ${m[1].toLowerCase() === "is" ? "is" : m[1].toLowerCase()} ${m[2].toLowerCase()}.`;
    const w = h.toLowerCase();
    if (!w.includes(" ") && ADJECTIVE.test(w)) return `This is ${article(w)} ${w} item.`;
    return `This is ${w}.`;
  }
  return `${cap(h)} is ${p}.`;
}

/** Positive label guess for yes/no: a yes-like value, else the rarer of the two most frequent values. */
export function guessPositive(rows: { value: string; count: number }[]): string {
  const yes = rows.find((r) => isYesLike(r.value));
  if (yes) return yes.value;
  if (rows.length >= 2) return rows[0].count >= rows[1].count ? rows[1].value : rows[0].value;
  return rows[0]?.value ?? "";
}
