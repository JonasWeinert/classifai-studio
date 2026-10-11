// Plain-language meaning of the numbers ClassifAI shows. One place, so the Playground, Bulk and
// experiments explain a number the same way. Models here give probabilities, not statistical
// tests: nothing is a p-value, and "confidence" is the model's own estimate, not a measured accuracy.

export const GLOSSARY = {
  confidence:
    "The percentage is the chance the model gives its answer (the highlighted bar). The word says how clear-cut that is given the number of options: 57% out of three options is only leaning, while 57% out of ten would be a clear pick. Both are the model's own estimate, not a measured accuracy — run an experiment against labelled data to see how far it can be trusted.",
  chanceYes:
    "The model's estimated chance that the answer is yes (0–100%). Above 50% reads as Yes. This is a probability, not a statistical p-value: no hypothesis is being tested.",
  probabilities: "How the model spreads its belief over the options. The bars add up to 100%; the highlighted one is its answer.",
  score:
    "The average point on the scale, weighted by how likely the model finds each point. 3.4 means it leans between 3 and 4, closer to 3.",
  threshold: "An option is selected when its chance reaches this line. Several options (or none) can apply at once.",
  multi: "Each option is judged on its own, so the chances don't add up to 100%.",
  rank: "Options from most to least likely; the percentage is the model's chance for each being the best fit.",
  range80: "The model puts an 80% chance on the true value lying in this range. A wide range means it is unsure.",
  mostLikely: "The single value the model finds most likely. The estimate in the headline is the probability-weighted average.",
  latency: "How long the model took to answer.",
  load: "One-off time to load a local model into memory before its first answer. Later answers skip it while the model stays loaded.",
  agreement: "Whether the selected models give the same answer. Disagreement is a good hint that a question is hard or ambiguous.",
  ece: "Calibration error: the gap between stated confidence and actual accuracy. Lower is better.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;

/** A word for the normalized confidence (0 = no likelier than the other options, 1 = certain), so the same top chance reads differently with 3 or 10 options. */
export function sureness(confidence: number): string {
  if (confidence >= 0.8) return "very sure";
  if (confidence >= 0.5) return "fairly sure";
  if (confidence >= 0.2) return "leaning";
  return "close to guessing";
}

/** Yes/no in words: "very likely yes", "toss-up", … */
export function yesNoWords(p: number): string {
  const d = Math.abs(p - 0.5);
  if (d < 0.05) return "a toss-up";
  const side = p >= 0.5 ? "yes" : "no";
  return d >= 0.4 ? `very likely ${side}` : d >= 0.25 ? `likely ${side}` : `leaning ${side}`;
}
