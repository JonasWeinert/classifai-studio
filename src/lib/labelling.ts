// Manual labelling helpers: question ids, how answers become dataset cells, and option keys.
import { KINDS, parseValues } from "./questionDraft";
import { slugId } from "./questions";
import { MODEL_COLORS } from "./format";
import { labelKeys, matches, resolveRoutes } from "./routing";
import type { LabelValue, QuestionSetPayload, SetQuestion } from "./types";

/** Each question's colour (by position): its card, its context passages and their highlights in the entry. */
export const questionColor = (i: number) => MODEL_COLORS[i % MODEL_COLORS.length];

/** A translucent version of a colour, for tints. */
export const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

export interface LabelQuestion {
  id: string;
  title: string;
  q: SetQuestion;
  /** Choices in the order they are shown and keyed (options, levels or candidate values). */
  choices: { value: string; label: string; description?: string }[];
  /** Follow-up: shown only when question `parent` (an id) is answered with one of `answers`. */
  route: { parent: string; answers: string[] } | null;
}

/** Questions with their ids (the same slugs the Playground and Bulk use) and choices. */
export function labelQuestions(payload: QuestionSetPayload | null | undefined): LabelQuestion[] {
  const ids: string[] = [];
  const all = (payload?.questions ?? []).map((q) => {
    const id = slugId(q.text || q.kind, ids);
    ids.push(id);
    return { ...q, id };
  });
  const routes = resolveRoutes(all);
  return all.map(({ id, ...q }) => {
    const title = q.text.trim() || KINDS.find((k) => k.value === q.kind)!.label;
    let choices: LabelQuestion["choices"] = [];
    if (q.kind === "choice" || q.kind === "multi" || q.kind === "rank") {
      choices = q.options.filter((o) => o.name.trim()).map((o) => ({ value: o.name.trim(), label: o.name.trim(), description: o.description.trim() || undefined }));
    } else if (q.kind === "score") {
      choices = q.levels.map((l) => l.trim()).filter(Boolean).map((l) => ({ value: l, label: l }));
    } else if (q.kind === "noul") {
      choices = [
        { value: "yes", label: "Yes", description: q.yes.trim() || undefined },
        { value: "no", label: "No", description: q.no.trim() || undefined },
      ];
    } else if (q.kind === "number") {
      choices = parseValues(q.values).map((v) => ({ value: String(v), label: `${v}${q.unit ? ` ${q.unit}` : ""}` }));
    }
    return { id, title, q, choices, route: routes.get(id) ?? null };
  });
}

/**
 * The questions that apply to an entry with these answers: every question without a condition,
 * and each follow-up whose earlier question (itself applying) was answered with a triggering answer.
 */
export function applicable(qs: LabelQuestion[], answers: Record<string, LabelValue>): LabelQuestion[] {
  const byId = new Map(qs.map((q) => [q.id, q]));
  const memo = new Map<string, boolean>();
  const applies = (q: LabelQuestion, depth = 0): boolean => {
    if (!q.route || depth > 20) return true;
    if (memo.has(q.id)) return memo.get(q.id)!;
    const p = byId.get(q.route.parent);
    const ok = !p || (applies(p, depth + 1) && matches(q.route, labelKeys(p.q.kind, answers[p.id])));
    memo.set(q.id, ok);
    return ok;
  };
  return qs.filter((q) => applies(q));
}

export const titlesOf = (qs: LabelQuestion[]) => Object.fromEntries(qs.map((x) => [x.id, x.title]));

export function isAnswered(v: LabelValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return v !== "";
}

/** An answer as one dataset cell: lists joined, yes/no spelled out. */
export function cellOf(q: LabelQuestion, v: LabelValue | undefined): string {
  if (!isAnswered(v)) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.join(q.q.kind === "rank" ? " > " : ", ");
  return String(v);
}

/** Key that picks choice `i`: 1–9, then 0, then a–z except letters used for commands. */
// Not c (context), e (note), f (flag), n (no), s (skip), u (next to do), y (yes).
const LETTERS = "abdghijklmopqrtvwxz";
export function choiceKey(i: number): string | null {
  if (i < 9) return String(i + 1);
  if (i === 9) return "0";
  return LETTERS[i - 10] ?? null;
}
export function choiceIndex(key: string): number | null {
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  if (key === "0") return 9;
  const i = LETTERS.indexOf(key.toLowerCase());
  return i >= 0 ? 10 + i : null;
}

/** Does a field look like an image we can show? */
/** Does a field look like an image we can show: a web URL, a data URL or an imported file path? */
export const isImageUrl = (v: string) => {
  const t = v.trim();
  return (
    /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i.test(t) ||
    /^https:\/\/datasets-server\.huggingface\.co\/assets\/\S+\.(png|jpe?g|webp)/i.test(t) ||
    /^data:image\//i.test(t) ||
    (/^(\/|[a-z]:\\)/i.test(t) && /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i.test(t))
  );
};
export const isUrl = (v: string) => /^https?:\/\/\S+$/.test(v.trim());
