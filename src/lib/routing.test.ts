import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ api: {} }));
import { applicable, labelQuestions } from "./labelling";
import { classifyRouted, type RoutedItem } from "./routing";
import type { AnyAnswer, QuickResult, SetQuestion } from "./types";

const noul = { type: "noul" } as const;
const choice = { type: "choice", criteria: { price: null, quality: null } } as const;
const items: RoutedItem[] = [
  { id: "refund", title: "Asks for a refund?", q: noul },
  { id: "why", title: "Why?", q: choice, route: { parent: "refund", answers: ["yes"] } },
  { id: "deep", title: "Deeper?", q: noul, route: { parent: "why", answers: ["price"] } },
  { id: "other", title: "Other?", q: noul, route: { parent: "refund", answers: ["no"] } },
];

function fakeAsk(refund: number) {
  const calls: { state: string; ids: string[] }[] = [];
  const ask = async (req: { state: string; questions?: Record<string, unknown> }): Promise<QuickResult> => {
    const ids = Object.keys(req.questions ?? {});
    calls.push({ state: req.state, ids });
    const answers: Record<string, AnyAnswer> = {};
    for (const id of ids) answers[id] = id === "why" ? { type: "choice", choice: "price", confidence: 0.8, probabilities: { price: 0.9, quality: 0.1 } } : { type: "noul", noul: id === "refund" ? refund : 0.7 };
    return { model: "m", answered_by: "m", answers, routing: null, latency_ms: 10, load_ms: 0, state_truncated: false, cost_usd: 0.001 };
  };
  return { ask: ask as never, calls };
}

describe("classifyRouted", () => {
  it("asks follow-ups in later passes with the earlier answers appended", async () => {
    const { ask, calls } = fakeAsk(0.9);
    const r = await classifyRouted("m", "I want my money back", items, ask);
    expect(calls.map((c) => c.ids)).toEqual([["refund"], ["why"], ["deep"]]);
    expect(calls[1].state).toContain("Earlier answers:\n- Asks for a refund?: yes");
    expect(calls[2].state).toContain("- Why?: price");
    expect(Object.keys(r.answers)).toEqual(["refund", "why", "deep"]);
    expect(r.followUps.why).toEqual({ parent: "refund", answer: "yes" });
    expect(r.notAsked).toEqual(["other"]);
    expect(r.passes).toBe(3);
    expect(r.latency_ms).toBe(30);
  });
  it("rules out a whole branch", async () => {
    const { ask, calls } = fakeAsk(0.1);
    const r = await classifyRouted("m", "x", items, ask);
    expect(calls.map((c) => c.ids)).toEqual([["refund"], ["other"]]);
    expect(r.notAsked.sort()).toEqual(["deep", "why"]);
  });
});

describe("applicable (manual labelling)", () => {
  const q = (kind: SetQuestion["kind"], text: string, rid: string, when?: SetQuestion["when"]): SetQuestion => ({ kind, text, context: "", options: [{ name: "price", description: "" }, { name: "quality", description: "" }], threshold: 0.5, yes: "", no: "", levels: [], values: "", unit: "", rid, when });
  const qs = labelQuestions({ context: "", questions: [q("noul", "Refund?", "a"), q("choice", "Why?", "b", { parent: "a", answers: ["yes"] })] });
  it("shows a follow-up once triggered", () => {
    expect(applicable(qs, {}).map((x) => x.id)).toEqual(["refund"]);
    expect(applicable(qs, { refund: false }).map((x) => x.id)).toEqual(["refund"]);
    expect(applicable(qs, { refund: true }).map((x) => x.id)).toEqual(["refund", "why"]);
  });
});
