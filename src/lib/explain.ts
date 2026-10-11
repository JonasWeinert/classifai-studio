// "Why this answer?": which parts of the input a model relied on, found by a removal test. The
// input is split into pieces (words, n-word chunks, sentences or paragraphs); each piece is left
// out in turn and the same questions are asked again. How far the chance of the original answer
// moves is that piece's effect: it drops when the piece supported the answer, rises when the piece
// argued against it. Works with any model (it only needs the probabilities), at one extra request
// per piece.
import { api } from "./api";
import type { AnyAnswer, AnyQuestion, QuickResult } from "./types";

export type Granularity = "word" | "words2" | "words3" | "words4" | "sentence" | "paragraph";

export const GRANULARITIES: { value: Granularity; label: string; hint: string }[] = [
  { value: "word", label: "Words", hint: "Finest detail, most requests" },
  { value: "words2", label: "2 words", hint: "Pairs of words" },
  { value: "words3", label: "3 words", hint: "Short phrases" },
  { value: "words4", label: "4 words", hint: "Longer phrases" },
  { value: "sentence", label: "Sentences", hint: "One request per sentence" },
  { value: "paragraph", label: "Paragraphs", hint: "Fewest requests, coarsest" },
];

/** A piece of the input: `[start, end)` in the original text. */
export interface Piece {
  start: number;
  end: number;
  text: string;
}

/** Above this many pieces the run is long; the UI asks for a coarser split. */
export const MAX_PIECES = 400;

const wordSpans = (text: string): Piece[] => [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));

function group(spans: Piece[], n: number, text: string): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < spans.length; i += n) {
    const part = spans.slice(i, i + n);
    const start = part[0].start;
    const end = part[part.length - 1].end;
    out.push({ start, end, text: text.slice(start, end) });
  }
  return out;
}

/** Trim a span to its non-space content; null when it is only whitespace. */
function trimmed(text: string, start: number, end: number): Piece | null {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end, text: text.slice(start, end) } : null;
}

function sentences(text: string): Piece[] {
  const out: Piece[] = [];
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
    for (const s of seg.segment(text)) {
      // Line breaks also end a sentence (subject lines, list items).
      let at = s.index;
      for (const line of s.segment.split(/(?<=\n)/)) {
        const p = trimmed(text, at, at + line.length);
        if (p) out.push(p);
        at += line.length;
      }
    }
    return out;
  }
  for (const m of text.matchAll(/[^.!?\n]+[.!?]*\s*/g)) {
    const p = trimmed(text, m.index!, m.index! + m[0].length);
    if (p) out.push(p);
  }
  return out;
}

function paragraphs(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const block of text.split(/(\n\s*\n)/)) {
    const p = trimmed(text, at, at + block.length);
    if (p) out.push(p);
    at += block.length;
  }
  // A single block: fall back to lines, so there is something to compare.
  if (out.length <= 1) {
    out.length = 0;
    at = 0;
    for (const line of text.split(/(\n)/)) {
      const p = trimmed(text, at, at + line.length);
      if (p) out.push(p);
      at += line.length;
    }
  }
  return out;
}

export function split(text: string, g: Granularity): Piece[] {
  switch (g) {
    case "word":
      return wordSpans(text);
    case "words2":
      return group(wordSpans(text), 2, text);
    case "words3":
      return group(wordSpans(text), 3, text);
    case "words4":
      return group(wordSpans(text), 4, text);
    case "sentence":
      return sentences(text);
    case "paragraph":
      return paragraphs(text);
  }
}

/** The input with one piece left out (and the doubled space it leaves tidied up). */
export function without(text: string, p: Piece): string {
  const before = text.slice(0, p.start);
  const after = text.slice(p.end);
  if (/\s$/.test(before) && /^[ \t]/.test(after)) return before + after.replace(/^[ \t]+/, "");
  return before + after;
}

/**
 * The chance `a` gives to the answer `orig` gave: the same option, the same side of yes/no, the
 * same set of options for pick-any (mean agreement per option), the same most likely number.
 */
export function supportFor(orig: AnyAnswer, a: AnyAnswer | undefined): number | null {
  if (!a || a.type !== orig.type || orig.type === "text") return null;
  switch (orig.type) {
    case "noul":
      return orig.noul >= 0.5 ? (a as typeof orig).noul : 1 - (a as typeof orig).noul;
    case "choice":
      return (a as typeof orig).probabilities[orig.choice] ?? 0;
    case "rank":
      return (a as typeof orig).probabilities[orig.ranking[0]] ?? 0;
    case "score":
      return (a as typeof orig).probabilities[String(Math.round(orig.score))] ?? 0;
    case "number":
      return (a as typeof orig).probabilities[String(orig.most_likely)] ?? 0;
    case "multi": {
      const ps = (a as typeof orig).probabilities;
      const keys = Object.keys(orig.probabilities);
      if (!keys.length) return null;
      return keys.reduce((s, k) => s + (orig.selected.includes(k) ? ps[k] ?? 0 : 1 - (ps[k] ?? 0)), 0) / keys.length;
    }
  }
}

/** Requests in flight: cloud models take parallel requests well, a local model a few. */
export const concurrencyFor = (model: string) => (model.startsWith("@") ? 6 : 3);

/** Rough time and cost of explaining with `pieces` pieces, from the answer it explains. */
export function estimate(model: string, base: QuickResult, pieces: number) {
  const parallel = concurrencyFor(model);
  // A local model slows a little with requests in flight; parallel requests are not free.
  const perRequest = base.latency_ms * (model.startsWith("@") ? 1 : 1.6);
  const ms = Math.ceil(pieces / parallel) * perRequest;
  return { requests: pieces, ms, cost: (base.cost_usd ?? 0) * pieces, parallel };
}

/** One piece's effect per question: the change in support when it is left out (negative = it supported the answer). */
export interface PieceEffect {
  piece: Piece;
  /** question id -> support without this piece minus support with it; missing when that request failed */
  delta: Record<string, number>;
  /** question id -> did leaving it out change the answer itself */
  flips: Record<string, boolean>;
  error?: string;
}

export interface Explanation {
  granularity: Granularity;
  pieces: PieceEffect[];
  /** question id -> support with the full input */
  base: Record<string, number>;
  done: number;
  total: number;
  running: boolean;
  cost: number;
  elapsedMs: number;
}

const answerKey = (a: AnyAnswer | undefined) => {
  if (!a) return "";
  switch (a.type) {
    case "noul":
      return a.noul >= 0.5 ? "yes" : "no";
    case "choice":
      return a.choice;
    case "rank":
      return a.ranking[0];
    case "score":
      return String(Math.round(a.score));
    case "number":
      return String(a.most_likely);
    case "multi":
      return [...a.selected].sort().join("|");
  }
};

/**
 * Run the removal test. Calls `onUpdate` as results arrive; `signal` stops it (what is done is kept).
 */
export async function explain(opts: {
  model: string;
  text: string;
  questions: Record<string, AnyQuestion>;
  base: QuickResult;
  granularity: Granularity;
  signal: { stopped: boolean };
  onUpdate: (e: Explanation) => void;
}): Promise<Explanation> {
  const { model, text, questions, base, granularity, signal, onUpdate } = opts;
  const pieces = split(text, granularity);
  const ids = Object.keys(base.answers);
  const baseSupport = Object.fromEntries(ids.map((id) => [id, supportFor(base.answers[id], base.answers[id]) ?? 0]));
  const t0 = performance.now();
  const state: Explanation = {
    granularity,
    pieces: pieces.map((piece) => ({ piece, delta: {}, flips: {} })),
    base: baseSupport,
    done: 0,
    total: pieces.length,
    running: true,
    cost: 0,
    elapsedMs: 0,
  };
  const push = () => onUpdate({ ...state, pieces: [...state.pieces], elapsedMs: performance.now() - t0 });
  push();

  let next = 0;
  const worker = async () => {
    while (!signal.stopped && next < pieces.length) {
      const i = next++;
      const piece = pieces[i];
      try {
        const r = await api.quickClassify({ model, state: without(text, piece), questions });
        const delta: Record<string, number> = {};
        const flips: Record<string, boolean> = {};
        for (const id of ids) {
          const s = supportFor(base.answers[id], r.answers[id]);
          if (s === null) continue;
          delta[id] = s - baseSupport[id];
          flips[id] = answerKey(r.answers[id]) !== answerKey(base.answers[id]);
        }
        state.pieces[i] = { piece, delta, flips };
        state.cost += r.cost_usd ?? 0;
      } catch (e) {
        state.pieces[i] = { piece, delta: {}, flips: {}, error: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e) };
      }
      state.done++;
      push();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrencyFor(model), pieces.length) }, worker));
  state.running = false;
  push();
  return { ...state, elapsedMs: performance.now() - t0 };
}
