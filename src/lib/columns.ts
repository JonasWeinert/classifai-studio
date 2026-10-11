// Heuristics for picking sensible default columns in a freshly imported dataset.

const LABEL_NAMES = ["label", "labels", "class", "category", "target", "gold", "ground_truth", "y", "intent", "sentiment", "department", "kind", "decision", "outcome", "include", "included", "eligible", "eligibility", "answer", "code", "status", "verdict", "result", "type"];

/** A column named like a label, if any. */
export function namedLabelColumn(cols: string[]): string | undefined {
  return cols.find((c) => LABEL_NAMES.includes(c.toLowerCase().replace(/[\s-]+/g, "_")));
}

export function guessLabelColumn(cols: string[]): string {
  return namedLabelColumn(cols) ?? cols[cols.length - 1];
}

export function guessInputColumns(cols: string[], label: string): string[] {
  const prefs = ["text", "body", "message", "content", "review", "sentence", "input", "description", "subject", "title"];
  const hits = cols.filter((c) => c !== label && prefs.includes(c.toLowerCase()));
  return hits.length ? hits : cols.filter((c) => c !== label).slice(0, 1);
}
