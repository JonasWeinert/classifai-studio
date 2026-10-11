// Turn a dataset column into a question: infer the question type from the column's values and how
// they are distributed, and match a model's answer against a row's value.
import { blank, fmt, type Kind, type QDraft } from "./questionDraft";
import type { AnyAnswer, ValueCount } from "./types";

export interface Inference {
  /** null: the column looks like free text (or is empty) and makes a poor question. */
  kind: Kind | null;
  /** One line on why, e.g. "4 distinct values". */
  reason: string;
  /** Options (choice / multi / rank), levels (score) or candidate values (number), most frequent first for labels. */
  values: string[];
  distinct: number;
}

const YES = ["yes", "y", "true", "t", "1", "ja", "positive", "pos"];
const NO = ["no", "n", "false", "f", "0", "nein", "negative", "neg"];
const SPLIT = /\s*[;,|]\s*/;
const MAX_CHOICES = 30;

const isNum = (v: string) => v.trim() !== "" && Number.isFinite(Number(v));

/** Distinct values merged case-insensitively, keeping the most frequent spelling. */
function merge(counts: ValueCount[]): ValueCount[] {
  const by = new Map<string, ValueCount & { best: number }>();
  for (const c of counts) {
    const v = c.value.trim();
    if (!v) continue;
    const k = v.toLowerCase().replace(/[.\s]+$/, "");
    const cur = by.get(k);
    if (!cur) by.set(k, { value: v, count: c.count, best: c.count });
    else {
      cur.count += c.count;
      if (c.count > cur.best) Object.assign(cur, { value: v, best: c.count });
    }
  }
  return [...by.values()].map(({ value, count }) => ({ value, count })).sort((a, b) => b.count - a.count);
}

/** A few round, spread-out candidate values for a numeric column: its quantiles. */
function candidates(nums: number[], n = 7): number[] {
  const sorted = [...nums].sort((a, b) => a - b);
  const q = Array.from({ length: n }, (_, i) => sorted[Math.round((i / (n - 1)) * (sorted.length - 1))]);
  const round = (v: number) => {
    if (v === 0) return 0;
    const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) - 1);
    return Math.round(v / p) * p;
  };
  return [...new Set(q.map(round))];
}

/**
 * Infer a question type from a column's value counts (as `dataset_value_counts` returns them, capped
 * at 300 distinct values) and the dataset's row count.
 */
export function inferColumn(counts: ValueCount[], rowCount: number): Inference {
  const vals = merge(counts);
  const distinct = vals.length;
  const filled = vals.reduce((a, v) => a + v.count, 0);
  const capped = counts.length >= 300;
  if (!distinct) return { kind: null, reason: "Empty column", values: [], distinct };

  const lower = vals.map((v) => v.value.toLowerCase());
  if (distinct <= 2 && lower.every((v) => YES.includes(v) || NO.includes(v)) && !lower.every(isNum)) {
    return { kind: "noul", reason: `Yes/no values (${vals.map((v) => v.value).join(" / ")})`, values: vals.map((v) => v.value), distinct };
  }
  if (distinct === 2 && lower.every((v) => v === "0" || v === "1")) {
    return { kind: "noul", reason: "Binary 0/1 values", values: vals.map((v) => v.value), distinct };
  }

  if (!capped && vals.every((v) => isNum(v.value))) {
    const nums = vals.map((v) => Number(v.value));
    const ints = nums.every(Number.isInteger);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    if (ints && distinct > 12 && distinct >= filled * 0.9) {
      return { kind: null, reason: "Unique whole numbers: looks like an ID", values: [], distinct };
    }
    if (ints && distinct >= 2 && distinct <= 10 && hi - lo <= 10) {
      const levels = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
      return { kind: "score", reason: `Whole numbers ${lo}–${hi}: an ordered scale`, values: levels, distinct };
    }
    const expanded = vals.flatMap((v) => Array(Math.min(v.count, 50)).fill(Number(v.value)) as number[]);
    const values = distinct <= 12 ? nums.sort((a, b) => a - b) : candidates(expanded);
    return { kind: "number", reason: `Numbers ${fmt(lo)}–${fmt(hi)}, ${distinct} distinct`, values: values.map(String), distinct };
  }

  // Several labels in one cell ("billing, refund"): pick-any over the separate labels.
  const multiCells = vals.filter((v) => SPLIT.test(v.value) && v.value.split(SPLIT).every((t) => t && t.length <= 40));
  const multiShare = multiCells.reduce((a, v) => a + v.count, 0) / Math.max(1, filled);
  if (multiShare >= 0.15) {
    const tokens = merge(vals.flatMap((v) => v.value.split(SPLIT).filter(Boolean).map((t) => ({ value: t, count: v.count }))));
    if (tokens.length >= 2 && tokens.length <= MAX_CHOICES) {
      return { kind: "multi", reason: `${tokens.length} labels, several per row`, values: tokens.map((t) => t.value), distinct: tokens.length };
    }
  }

  const avgLen = vals.reduce((a, v) => a + v.value.length * v.count, 0) / Math.max(1, filled);
  const repeats = distinct < Math.max(2, rowCount * 0.5);
  if (!capped && distinct >= 2 && distinct <= MAX_CHOICES && repeats && avgLen <= 60) {
    return { kind: "choice", reason: `${distinct} distinct labels`, values: vals.map((v) => v.value), distinct };
  }
  if (distinct === 1) return { kind: null, reason: `Only one value (“${vals[0].value}”)`, values: [vals[0].value], distinct };
  return { kind: null, reason: capped ? "Free text: 300+ distinct values" : `Free text: ${distinct} distinct values`, values: [], distinct };
}

/** Values a kind needs when the user overrides the inferred one. */
function valuesFor(kind: Kind, inf: Inference, counts: ValueCount[]): string[] {
  if (kind === inf.kind) return inf.values;
  const vals = merge(counts).map((v) => v.value);
  if (kind === "number") return candidates(vals.filter(isNum).map(Number)).map(String);
  return vals.slice(0, MAX_CHOICES);
}

const human = (col: string) => col.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** A question draft for a column, of the given (or inferred) kind. */
export function columnQuestion(column: string, kind: Kind, inf: Inference, counts: ValueCount[], expected?: string): QDraft {
  const h = human(column);
  const values = valuesFor(kind, inf, counts);
  const options = values.map((name) => ({ name, description: "" }));
  const base = { ...blank(kind), column, expected };
  switch (kind) {
    case "choice":
      return { ...base, text: `What is the ${h}?`, options: options.length >= 2 ? options : base.options };
    case "rank":
      return { ...base, text: `Which ${h} fits best?`, options: options.length >= 2 ? options : base.options };
    case "multi":
      return { ...base, text: `Which ${h} labels apply?`, options: options.length ? options : base.options };
    case "noul":
      return { ...base, text: h.charAt(0).toUpperCase() + h.slice(1) };
    case "score":
      return { ...base, text: `How would you rate the ${h}?`, levels: values.length >= 2 ? values : base.levels };
    case "number":
      return { ...base, text: `What is the ${h}?`, values: values.join(", ") || base.values };
    case "text":
      return { ...base, text: `What is the ${h}?` };
  }
}

/** Does an answer match a dataset value? null when the value can't be compared. */
export function matchesExpected(a: AnyAnswer, expected: string): boolean | null {
  const e = expected.trim().toLowerCase();
  if (!e) return null;
  const same = (x: string) => x.trim().toLowerCase() === e;
  switch (a.type) {
    case "choice":
      return same(a.choice);
    case "rank":
      return same(a.ranking[0]);
    case "noul":
      if (YES.includes(e)) return a.noul >= 0.5;
      if (NO.includes(e)) return a.noul < 0.5;
      return null;
    case "score":
      return same(a.legend[String(Math.round(a.score))] ?? "");
    case "number":
      return isNum(e) ? Number(e) === a.most_likely || (Number(e) >= a.range[0] && Number(e) <= a.range[1]) : null;
    case "text":
      // A written answer can't be checked against a value by exact match.
      return null;
    case "multi": {
      const want = new Set(e.split(SPLIT).filter(Boolean));
      const got = new Set(a.selected.map((s) => s.trim().toLowerCase()));
      return want.size === got.size && [...want].every((w) => got.has(w));
    }
  }
}
