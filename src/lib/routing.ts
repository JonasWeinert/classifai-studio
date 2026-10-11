// Question routing: a follow-up question is asked only when an earlier question got one of the
// chosen answers ("if No → ask X"). Models answer the questions without a condition first; each
// further pass asks the follow-ups that were triggered, with the earlier questions and their
// answers appended to the input. In manual labelling, follow-ups appear once triggered.
import { api } from "./api";
import type { AnyAnswer, AnyQuestion, LabelValue, QuickResult } from "./types";

/** "Ask only when the question `parent` (its stable `rid`) is one of `answers`." */
export interface Route {
  parent: string;
  answers: string[];
}

/** A question that can carry follow-ups: one whose answer is one (or a few) named options. */
export const PARENT_KINDS = ["choice", "noul", "score", "multi", "rank"] as const;
export const canHaveFollowUps = (kind: string) => (PARENT_KINDS as readonly string[]).includes(kind);

/** A stable id for a question, so follow-ups keep pointing at it when its wording changes. */
export const newRid = () => Math.random().toString(36).slice(2, 10);

/** The answers a follow-up can be tied to, for a question in the editor's shape. */
export function answerChoices(q: { kind: string; options: { name: string }[]; levels: string[] }): string[] {
  switch (q.kind) {
    case "choice":
    case "multi":
    case "rank":
      return q.options.map((o) => o.name.trim()).filter(Boolean);
    case "noul":
      return ["yes", "no"];
    case "score":
      return q.levels.map((l) => l.trim()).filter(Boolean);
    default:
      return [];
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const matches = (route: Route, keys: string[]) => keys.some((k) => route.answers.some((a) => same(a, k)));

/** What a model's answer counts as for routing: the option(s) it picked. */
export function answerKeys(a: AnyAnswer | undefined): string[] {
  if (!a) return [];
  switch (a.type) {
    case "choice":
      return [a.choice];
    case "noul":
      return [a.noul >= 0.5 ? "yes" : "no"];
    case "score":
      return [a.legend[String(Math.round(a.score))] ?? String(Math.round(a.score))];
    case "multi":
      return a.selected;
    case "rank":
      return a.ranking.slice(0, 1);
    case "number":
    case "text":
      return [];
  }
}

/** What a manual label counts as for routing. Rank answers count by their first pick. */
export function labelKeys(kind: string, v: LabelValue | undefined): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (typeof v === "boolean") return [v ? "yes" : "no"];
  if (Array.isArray(v)) return kind === "rank" ? v.slice(0, 1).map(String) : v.map(String);
  return [String(v)];
}

/** The input for a follow-up pass: the original input with the earlier questions and their answers. */
export function withEarlierAnswers(text: string, earlier: { title: string; answer: string }[]): string {
  if (!earlier.length) return text;
  return `${text}\n\nEarlier answers:\n${earlier.map((e) => `- ${e.title}: ${e.answer}`).join("\n")}`;
}

/** A question as the runners need it: wire question, title and (resolved to question ids) its route. */
export interface RoutedItem {
  id: string;
  title: string;
  q: AnyQuestion;
  /** `parent` is the parent's question id here. */
  route?: { parent: string; answers: string[] } | null;
}

/** Resolve routes from stable ids to question ids; a route to a missing (or unroutable) question is dropped. */
export function resolveRoutes<T extends { id: string; rid?: string; kind: string; when?: Route | null }>(qs: T[]): Map<string, { parent: string; answers: string[] }> {
  const byRid = new Map(qs.filter((q) => q.rid).map((q) => [q.rid!, q]));
  const out = new Map<string, { parent: string; answers: string[] }>();
  for (const q of qs) {
    const p = q.when ? byRid.get(q.when.parent) : undefined;
    if (p && p !== q && canHaveFollowUps(p.kind) && q.when!.answers.length) out.set(q.id, { parent: p.id, answers: q.when!.answers });
  }
  return out;
}

export interface RoutedResult extends QuickResult {
  /** Follow-ups that were asked: question id -> the parent and the answer that triggered it. */
  followUps: Record<string, { parent: string; answer: string }>;
  /** Follow-ups not asked because their parent's answer didn't trigger them (or the parent wasn't asked). */
  notAsked: string[];
  /** Requests made (1 without follow-ups). */
  passes: number;
}

/** Headline of an answer, for "Earlier answers" lines. */
function answerText(a: AnyAnswer): string {
  const keys = answerKeys(a);
  if (a.type === "number") return `${a.most_likely}${a.unit ? ` ${a.unit}` : ""}`;
  return keys.join(", ") || "none";
}

/**
 * Ask `items` with routing: questions without a route first, then one request per round for the
 * follow-ups the answers so far triggered, with their ancestors' questions and answers appended.
 */
export async function classifyRouted(model: string, text: string, items: RoutedItem[], ask = api.quickClassify): Promise<RoutedResult> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const isRoot = (i: RoutedItem) => !i.route || !byId.has(i.route.parent);
  const answers: Record<string, AnyAnswer> = {};
  const followUps: RoutedResult["followUps"] = {};
  const asked = new Set<string>();
  const decided = new Set<string>(); // asked or ruled out
  let merged = null as RoutedResult | null;
  let round = items.filter(isRoot);

  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    let cur = byId.get(id);
    while (cur && !isRoot(cur)) {
      out.unshift(cur.route!.parent);
      cur = byId.get(cur.route!.parent);
    }
    return out;
  };

  while (round.length) {
    const earlier = [...new Set(round.flatMap((i) => (isRoot(i) ? [] : ancestors(i.id))))]
      .filter((id) => answers[id])
      .map((id) => ({ title: byId.get(id)!.title, answer: answerText(answers[id]) }));
    const r = await ask({ model, state: withEarlierAnswers(text, earlier), questions: Object.fromEntries(round.map((i) => [i.id, i.q])) });
    for (const i of round) {
      asked.add(i.id);
      decided.add(i.id);
      if (r.answers[i.id]) answers[i.id] = r.answers[i.id];
    }
    merged = merged
      ? {
          ...merged,
          latency_ms: merged.latency_ms + r.latency_ms,
          load_ms: merged.load_ms + r.load_ms,
          cost_usd: (merged.cost_usd ?? 0) + (r.cost_usd ?? 0),
          state_truncated: merged.state_truncated || r.state_truncated,
          refused: [...(merged.refused ?? []), ...(r.refused ?? [])],
          quotes: { ...merged.quotes, ...r.quotes },
          passes: merged.passes + 1,
        }
      : { ...r, followUps, notAsked: [], passes: 1 };
    // Next round: follow-ups whose parent was just decided.
    const next: RoutedItem[] = [];
    for (const i of items) {
      if (decided.has(i.id) || isRoot(i) || !decided.has(i.route!.parent)) continue;
      const pa = answers[i.route!.parent];
      const hit = asked.has(i.route!.parent) ? answerKeys(pa).find((k) => i.route!.answers.some((a) => same(a, k))) : undefined;
      if (hit !== undefined) {
        followUps[i.id] = { parent: i.route!.parent, answer: hit };
        next.push(i);
      } else decided.add(i.id); // ruled out; its own follow-ups are ruled out next round
    }
    round = next;
    // Ruled-out questions rule out their follow-ups too.
    let changed = true;
    while (changed) {
      changed = false;
      for (const i of items) {
        if (!decided.has(i.id) && !isRoot(i) && decided.has(i.route!.parent) && !asked.has(i.route!.parent)) {
          decided.add(i.id);
          changed = true;
        }
      }
    }
  }
  if (!merged) throw { code: "INVALID", message: "Every question is a follow-up, so there is nothing to ask first" };
  const result: RoutedResult = merged;
  return {
    ...result,
    // Answers in question order, whatever pass they came from.
    answers: Object.fromEntries(items.filter((i) => answers[i.id]).map((i) => [i.id, answers[i.id]])),
    followUps,
    notAsked: items.filter((i) => !asked.has(i.id)).map((i) => i.id),
  };
}
