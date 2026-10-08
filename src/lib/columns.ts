// Heuristics for picking sensible default columns in a freshly imported dataset.

export function guessLabelColumn(cols: string[]): string {
  const prefs = ["label", "labels", "class", "category", "target", "gold", "ground_truth", "y", "intent", "sentiment", "department"];
  return cols.find((c) => prefs.includes(c.toLowerCase())) ?? cols[cols.length - 1];
}

export function guessInputColumns(cols: string[], label: string): string[] {
  const prefs = ["text", "body", "message", "content", "review", "sentence", "input", "description", "subject", "title"];
  const hits = cols.filter((c) => c !== label && prefs.includes(c.toLowerCase()));
  return hits.length ? hits : cols.filter((c) => c !== label).slice(0, 1);
}
