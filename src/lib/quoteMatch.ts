// Finding an LLM's supporting quote in the input. Models are asked for a verbatim passage but often
// change whitespace, quotes, case or a word or two, so the match is made over words: the longest
// run of words shared with the input anchors it, and the span the whole quote would cover there
// is kept when enough of its words are in it.

export interface QuoteMatch {
  start: number;
  end: number;
  /** The passage appears as quoted (ignoring case, spacing and punctuation). */
  exact: boolean;
  /** Share of the quote's words found in the span, 0–1. */
  score: number;
}

/** Below this share of the quote's words, the passage counts as not found. */
const MIN_SCORE = 0.6;

const norm = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

function words(s: string): { w: string; start: number; end: number }[] {
  const out: { w: string; start: number; end: number }[] = [];
  for (const m of s.matchAll(/\S+/g)) {
    const w = norm(m[0]);
    if (w) out.push({ w, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Where `quote` is in `text`, or null when it isn't (closely enough). */
export function matchQuote(text: string, quote: string): QuoteMatch | null {
  const q = words(quote).map((x) => x.w);
  const t = words(text);
  if (!q.length || !t.length) return null;
  // Longest run of consecutive words shared by quote and input (DP over one row).
  let best = { len: 0, ti: 0, qi: 0 };
  let prev = new Array(q.length + 1).fill(0);
  for (let i = 1; i <= t.length; i++) {
    const cur = new Array(q.length + 1).fill(0);
    for (let j = 1; j <= q.length; j++) {
      if (t[i - 1].w === q[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.len) best = { len: cur[j], ti: i - cur[j], qi: j - cur[j] };
      }
    }
    prev = cur;
  }
  if (!best.len) return null;
  if (best.len === q.length) return { start: t[best.ti].start, end: t[best.ti + q.length - 1].end, exact: true, score: 1 };
  // The span the whole quote would take around the anchor; count the quote's words found in it.
  const from = Math.max(0, best.ti - best.qi);
  const to = Math.min(t.length - 1, best.ti - best.qi + q.length - 1);
  const pool = new Map<string, number>();
  for (let i = from; i <= to; i++) pool.set(t[i].w, (pool.get(t[i].w) ?? 0) + 1);
  let hit = 0;
  for (const w of q) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(w, n - 1);
    }
  }
  const score = hit / q.length;
  return score >= MIN_SCORE ? { start: t[from].start, end: t[to].end, exact: false, score } : null;
}
