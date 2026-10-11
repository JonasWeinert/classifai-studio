import { describe, expect, it } from "vitest";
import { matchQuote } from "./quoteMatch";

const text = "Hello team,\nI was  charged twice this month. Order #48213. Please refund it!";

describe("matchQuote", () => {
  it("finds a verbatim quote despite spacing, case and punctuation", () => {
    const m = matchQuote(text, "“I was charged TWICE this month”")!;
    expect(m.exact).toBe(true);
    expect(text.slice(m.start, m.end)).toBe("I was  charged twice this month.");
  });
  it("finds a slightly changed quote approximately", () => {
    const m = matchQuote(text, "I was charged two times this month")!;
    expect(m.exact).toBe(false);
    expect(text.slice(m.start, m.end)).toContain("charged twice this");
  });
  it("gives up on a paraphrase", () => {
    expect(matchQuote(text, "the customer wants their money back")).toBeNull();
    expect(matchQuote(text, "")).toBeNull();
  });
});
