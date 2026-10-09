// Question drafts: the editor's shape, conversion to wire questions, and the draft shared by the
// Playground and Bulk pages.
import { useMemo, useSyncExternalStore } from "react";
import { load, save } from "./persist";
import { composeInstructions, slugId } from "./questions";
import type { AnyAnswer, AnyQuestion, Question } from "./types";

export type Kind = "choice" | "multi" | "noul" | "score" | "rank" | "number";

export const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "choice", label: "Pick one", hint: "One label from a list" },
  { value: "multi", label: "Pick any", hint: "Every label that applies — one yes/no per option" },
  { value: "noul", label: "Yes / No", hint: "Probability that a statement is true" },
  { value: "score", label: "Scale", hint: "2–10 ordered levels" },
  { value: "rank", label: "Rank", hint: "All options ordered from most to least fitting" },
  { value: "number", label: "Number", hint: "Expected value and 80% range over candidate values" },
];

export interface Opt {
  name: string;
  description: string;
}

export interface QDraft {
  key: number;
  kind: Kind;
  /** The question / statement shown to the model. */
  text: string;
  context: string;
  options: Opt[];
  threshold: number;
  yes: string;
  no: string;
  levels: string[];
  values: string;
  unit: string;
}

let nextKey = 1;
export const newKey = () => nextKey++;
export const blank = (kind: Kind = "choice", text = ""): QDraft => ({
  key: nextKey++,
  kind,
  text,
  context: "",
  options: [
    { name: "", description: "" },
    { name: "", description: "" },
  ],
  threshold: 0.5,
  yes: "",
  no: "",
  levels: ["Low", "Medium", "High"],
  values: "0, 1, 3, 7, 14, 30",
  unit: "",
});

export const EXAMPLE = (): QDraft[] => [
  {
    ...blank("choice", "Which team should handle this message?"),
    options: [
      { name: "billing", description: "Payments, invoices and refunds" },
      { name: "technical", description: "Bugs, errors and outages" },
      { name: "account", description: "Login, profile and settings" },
    ],
  },
  { ...blank("noul", "The customer asks for money back."), yes: "Explicitly requests a refund or chargeback", no: "" },
  { ...blank("score", "How frustrated is the customer?"), levels: ["Calm", "Annoyed", "Frustrated", "Furious"] },
];

export const SAMPLE_TEXT = "Third time this year you've double-charged me. Refund it today or I'm cancelling and moving to a competitor.";

export function parseValues(s: string) {
  return [...new Set(s.split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite))];
}

export function buildQuestion(q: QDraft, shared: string): AnyQuestion | null {
  const instructions = composeInstructions(q.text, shared, q.context) || undefined;
  const opts = q.options.filter((o) => o.name.trim());
  const criteria = Object.fromEntries(opts.map((o) => [o.name.trim(), o.description.trim() || null]));
  switch (q.kind) {
    case "choice":
      return opts.length >= 2 ? { type: "choice", instructions, criteria } : null;
    case "rank":
      return opts.length >= 2 ? { type: "rank", instructions, criteria } : null;
    case "multi":
      return opts.length >= 1 ? { type: "multi", instructions, criteria, threshold: q.threshold } : null;
    case "noul": {
      if (!q.text.trim()) return null;
      const yes = q.yes.trim(), no = q.no.trim();
      return { type: "noul", instructions, ...(yes || no ? { criteria: { ...(yes && { true: yes }), ...(no && { false: no }) } } : {}) };
    }
    case "score": {
      const levels = q.levels.map((l) => l.trim()).filter(Boolean);
      return levels.length >= 2 ? { type: "score", instructions, criteria: levels } : null;
    }
    case "number": {
      const values = parseValues(q.values);
      return values.length >= 2 ? { type: "number", instructions, values, unit: q.unit.trim() || null } : null;
    }
  }
}

export function headline(a: AnyAnswer): string {
  switch (a.type) {
    case "choice":
      return a.choice;
    case "noul":
      return a.noul >= 0.5 ? "Yes" : "No";
    case "score":
      return a.legend[String(Math.round(a.score))] ?? a.score.toFixed(2);
    case "multi":
      return a.selected.length ? a.selected.join(", ") : "None apply";
    case "rank":
      return a.ranking[0];
    case "number":
      return `${fmt(a.estimate)}${a.unit ? ` ${a.unit}` : ""}`;
  }
}

/** What "agreeing" means per type: same label, same yes/no, same most-likely value, same set. */
export function consensusKey(a: AnyAnswer): string {
  switch (a.type) {
    case "number":
      return `${fmt(a.most_likely)}${a.unit ? ` ${a.unit}` : ""}`;
    case "multi":
      return [...a.selected].sort().join(", ") || "None apply";
    case "score":
      return String(Math.round(a.score));
    default:
      return headline(a);
  }
}

export const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(2)).toString());

/** An Ollaya/TypeSafe wire question (e.g. from a preset) as an editable draft. */
export function fromWire(id: string, q: Question): Omit<QDraft, "key"> {
  const text = typeof q.instructions === "string" && q.instructions.trim() ? q.instructions : id.replace(/_/g, " ");
  const base = { ...blank(), text, context: "" };
  if (q.type === "choice") {
    const criteria = Array.isArray(q.criteria) ? Object.fromEntries((q.criteria as string[]).map((c) => [c, null])) : q.criteria;
    return { ...base, kind: "choice", options: Object.entries(criteria).map(([name, d]) => ({ name, description: typeof d === "string" ? d : "" })) };
  }
  if (q.type === "score") return { ...base, kind: "score", levels: q.criteria.map((c) => (typeof c === "string" ? c : JSON.stringify(c))) };
  return { ...base, kind: "noul", yes: q.criteria?.true ?? "", no: q.criteria?.false ?? "" };
}

// ---- shared draft: the same questions in Playground and Bulk ----------------------------------------

export interface DraftState {
  qs: QDraft[];
  shared: string;
  set: { id: string; name: string; version: number } | null;
}

type Persisted = Omit<DraftState, "qs"> & { qs: Omit<QDraft, "key">[] };

function initial(): DraftState {
  // Older builds kept the draft inside the Playground's own saved state.
  const p = load<Persisted | null>("questions", null) ?? load<Persisted | null>("quick", null);
  return {
    qs: p?.qs?.length ? p.qs.map((q) => ({ ...q, key: nextKey++ })) : EXAMPLE(),
    shared: p?.shared ?? "",
    set: p?.set ?? null,
  };
}

let state: DraftState | null = null;
const listeners = new Set<() => void>();

function getState() {
  return (state ??= initial());
}

function setState(patch: Partial<DraftState>) {
  state = { ...getState(), ...patch };
  save("questions", { qs: state.qs.map(({ key: _k, ...q }) => q), shared: state.shared, set: state.set });
  listeners.forEach((l) => l());
}

/** The question draft shared by Playground and Bulk, persisted on this Mac. */
export function useQuestionDraft() {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getState,
  );
  // Question ids derive from their text; the map keeps ids unique and readable.
  const built = useMemo(() => {
    const ids: string[] = [];
    return s.qs.map((q) => {
      const id = slugId(q.text || q.kind, ids);
      ids.push(id);
      return { id, title: q.text.trim() || KINDS.find((k) => k.value === q.kind)!.label, q: buildQuestion(q, s.shared) };
    });
  }, [s.qs, s.shared]);
  return {
    ...s,
    built,
    invalid: built.filter((b) => !b.q).length,
    setQs: (qs: QDraft[]) => setState({ qs }),
    setShared: (shared: string) => setState({ shared }),
    setSet: (set: DraftState["set"]) => setState({ set }),
    update: (key: number, patch: Partial<QDraft>) => setState({ qs: getState().qs.map((q) => (q.key === key ? { ...q, ...patch } : q)) }),
    reset: () => setState({ qs: EXAMPLE(), shared: "", set: null }),
  };
}

export type BuiltQuestion = ReturnType<typeof useQuestionDraft>["built"][number];
