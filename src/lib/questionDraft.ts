// Question drafts: the editor's shape, conversion to wire questions, and the draft shared by the
// Playground and Bulk pages.
import { useMemo, useSyncExternalStore } from "react";
import { load, save } from "./persist";
import { composeInstructions, slugId } from "./questions";
import { answerChoices, newRid, resolveRoutes, type Route } from "./routing";
import { supportsFreeText } from "./models";
import type { AnyAnswer, AnyQuestion, Question, QuestionSet } from "./types";

export type Kind = "choice" | "multi" | "noul" | "score" | "rank" | "number" | "text";

export const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "choice", label: "Pick one", hint: "One label from a list" },
  { value: "multi", label: "Pick any", hint: "Every label that applies — one yes/no per option" },
  { value: "noul", label: "Yes / No", hint: "Probability that a statement is true" },
  { value: "score", label: "Scale", hint: "2–10 ordered levels" },
  { value: "rank", label: "Rank", hint: "All options ordered from most to least fitting" },
  { value: "number", label: "Number", hint: "Expected value and 80% range over candidate values" },
  { value: "text", label: "Free text", hint: "An open answer in words" },
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
  /** Dataset column this question was made from (Open in Playground). */
  column?: string;
  /** That column's value in the opened row, shown next to the answers. */
  expected?: string;
  /** Raw column value → the answer it stands for (labels and aliases; yes/no for a yes/no question), when known from an evaluation. */
  labelOf?: Record<string, string>;
  /** Stable id, so follow-ups keep pointing at this question when it is reworded. */
  rid?: string;
  /** Follow-up: ask only when the question with rid `parent` got one of `answers`. */
  when?: Route | null;
}

let nextKey = 1;
export const newKey = () => nextKey++;
export const blank = (kind: Kind = "choice", text = ""): QDraft => ({
  key: nextKey++,
  rid: newRid(),
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
    case "text":
      // Only LLMs answer these; runners leave them out for decision models (see `supportsFreeText`).
      return q.text.trim() ? { type: "text", instructions } : null;
  }
}

/**
 * Insert a follow-up of question `key` after it and its existing follow-ups, tied to `answer`
 * (default: its first answer). The parent gets a stable id if it has none yet.
 */
export function addFollowUp(qs: QDraft[], key: number, answer?: string): QDraft[] {
  const out = qs.map((q) => (q.key === key && !q.rid ? { ...q, rid: newRid() } : q));
  const at = out.findIndex((q) => q.key === key);
  const parent = out[at];
  const first = answer ?? answerChoices(parent)[0];
  // Below the parent's block: everything after it that descends from it.
  const inBlock = (q: QDraft): boolean => {
    let cur: QDraft | undefined = q;
    for (let d = 0; cur?.when && d < 10; d++) {
      if (cur.when.parent === parent.rid) return true;
      cur = out.find((x) => x.rid === cur!.when!.parent);
    }
    return false;
  };
  let end = at + 1;
  while (end < out.length && inBlock(out[end])) end++;
  const child: QDraft = { ...blank(parent.kind === "noul" ? "noul" : "choice"), when: { parent: parent.rid!, answers: first ? [first] : [] } };
  return [...out.slice(0, end), child, ...out.slice(end)];
}

/** Remove a question; its follow-ups become regular questions. */
export function removeQuestion(qs: QDraft[], key: number): QDraft[] {
  const gone = qs.find((q) => q.key === key);
  return qs.filter((q) => q.key !== key).map((q) => (gone?.rid && q.when?.parent === gone.rid ? { ...q, when: null } : q));
}

/** Is the draft complete? Free-text questions only need their wording. */
export const isComplete = (q: QDraft, shared: string) => (q.kind === "text" ? !!q.text.trim() : !!buildQuestion(q, shared));

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
    case "text":
      return a.text;
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
  if (q.type === "text") return { ...base, kind: "text" };
  return { ...base, kind: "noul", yes: q.criteria?.true ?? "", no: q.criteria?.false ?? "" };
}

// ---- shared draft: the same questions in Playground and Bulk ----------------------------------------

export interface DraftState {
  qs: QDraft[];
  shared: string;
  /** The question set the draft was loaded from; `hash` tells whether it was edited since. */
  set: { id: string; name: string; version: number; hash?: string } | null;
}

/** Fingerprint of questions + context, to tell an edited draft from its saved set. */
export function draftHash(qs: Omit<QDraft, "key">[], context: string) {
  return JSON.stringify([context.trim(), qs.map(({ key: _k, column: _c, expected: _e, ...q }: Partial<QDraft>) => q)]);
}

/** Replace the shared draft with questions stored elsewhere (e.g. a Bulk run's setup). */
export function loadQuestionsIntoDraft(questions: Omit<QDraft, "key">[], context: string, set: DraftState["set"]) {
  setState({ qs: questions.map((x) => ({ ...x, key: nextKey++ })), shared: context, set });
}

/** Replace the shared Playground/Bulk draft with a saved question set. */
export function loadSetIntoDraft(q: QuestionSet) {
  setState({
    qs: q.payload.questions.map((x) => ({ ...x, key: nextKey++ })),
    shared: q.payload.context ?? "",
    set: { id: q.id, name: q.name, version: q.version, hash: draftHash(q.payload.questions, q.payload.context ?? "") },
  });
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
    const withIds = s.qs.map((q) => {
      const id = slugId(q.text || q.kind, ids);
      ids.push(id);
      return { ...q, id };
    });
    const routes = resolveRoutes(withIds);
    return withIds.map((q) => ({
      id: q.id,
      title: q.text.trim() || KINDS.find((k) => k.value === q.kind)!.label,
      q: buildQuestion(q, s.shared),
      freeText: q.kind === "text",
      complete: isComplete(q, s.shared),
      /** Follow-up: asked only when question `parent` (an id) got one of `answers`. */
      route: routes.get(q.id) ?? null,
    }));
  }, [s.qs, s.shared]);
  return {
    ...s,
    built,
    invalid: built.filter((b) => !b.complete).length,
    /** Questions decision models can answer (free-text ones are left out). */
    sendable: built.filter((b) => b.q && b.q.type !== "text"),
    /** Questions `model` can answer: everything for an LLM, all but free text for a decision model. */
    sendableFor: (model: string) => built.filter((b) => b.q && (b.q.type !== "text" || supportsFreeText(model))),
    edited: !!s.set?.hash && s.set.hash !== draftHash(s.qs, s.shared),
    setQs: (qs: QDraft[]) => setState({ qs }),
    setShared: (shared: string) => setState({ shared }),
    setSet: (set: DraftState["set"]) => setState({ set }),
    update: (key: number, patch: Partial<QDraft>) => setState({ qs: getState().qs.map((q) => (q.key === key ? { ...q, ...patch } : q)) }),
    reset: () => setState({ qs: EXAMPLE(), shared: "", set: null }),
  };
}

export type BuiltQuestion = ReturnType<typeof useQuestionDraft>["built"][number];
