export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
export const num = (v: number, digits = 3) => v.toFixed(digits);

export function ms(v: number) {
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${v.toFixed(0)} ms`;
  return `${v.toFixed(1)} ms`;
}

export function bytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** `laya:latest` → `laya` for display; Ollaya canonical names always carry a tag. */
export const shortModel = (m: string) => m.replace(/:latest$/, "").replace(/^@[^/]+\//, "");

// Stable, distinguishable colors per model (by position in an experiment).
export const MODEL_COLORS = ["#7c5cff", "#06b6d4", "#f59e0b", "#ec4899", "#10b981", "#ef4444", "#3b82f6", "#a855f7"];
export const modelColor = (i: number) => MODEL_COLORS[i % MODEL_COLORS.length];

/** "$0.042/M" — price per million input tokens. */
export const price = (perMTok: number) => (perMTok > 0 ? `$${perMTok < 1 ? perMTok.toFixed(3).replace(/0+$/, "") : perMTok.toFixed(2)}/M` : "free");

/** Money amounts that are often fractions of a cent. */
export function usd(v: number) {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
