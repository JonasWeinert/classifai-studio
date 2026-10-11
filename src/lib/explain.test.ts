import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ api: {} }));
import { split, supportFor, without } from "./explain";

const text = "Subject: Refund please\nI was charged twice. Please send my money back!\n\nThanks, Ana";

describe("split", () => {
  it("keeps offsets into the original text", () => {
    for (const g of ["word", "words3", "sentence", "paragraph"] as const) {
      for (const p of split(text, g)) expect(text.slice(p.start, p.end)).toBe(p.text);
    }
  });
  it("groups words", () => {
    expect(split("a b c d e", "words2").map((p) => p.text)).toEqual(["a b", "c d", "e"]);
  });
  it("splits sentences and lines", () => {
    expect(split(text, "sentence").map((p) => p.text)).toEqual(["Subject: Refund please", "I was charged twice.", "Please send my money back!", "Thanks, Ana"]);
  });
  it("splits paragraphs, falling back to lines", () => {
    expect(split(text, "paragraph")).toHaveLength(2);
    expect(split("one\ntwo", "paragraph").map((p) => p.text)).toEqual(["one", "two"]);
  });
});

describe("without", () => {
  it("leaves no doubled space", () => {
    const [, b] = split("I was charged twice", "word");
    expect(without("I was charged twice", b)).toBe("I charged twice");
  });
});

describe("supportFor", () => {
  it("measures the chance of the original answer", () => {
    const orig = { type: "noul" as const, noul: 0.2 };
    expect(supportFor(orig, { type: "noul", noul: 0.4 })).toBeCloseTo(0.6);
    const choice = { type: "choice" as const, choice: "billing", confidence: 0.5, probabilities: { billing: 0.7, tech: 0.3 } };
    expect(supportFor(choice, { ...choice, choice: "tech", probabilities: { billing: 0.4, tech: 0.6 } })).toBe(0.4);
  });
});
