import { describe, expect, it } from "vitest";
import { candidateValues, parseCsv, parseQuestionFile } from "./questionImport";

const kinds = (r: ReturnType<typeof parseQuestionFile>) => r.payload.questions.map((q) => q.kind);

describe("JSON Schema", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Ticket triage",
    description: "Support tickets of a SaaS company.",
    type: "object",
    properties: {
      team: { type: "string", enum: ["billing", "technical", "account"], description: "Which team should handle this?" },
      refund: { type: "boolean", description: "The customer asks for money back." },
      frustration: { type: "integer", minimum: 1, maximum: 5, title: "Frustration" },
      topics: { type: "array", items: { enum: ["price", "bug", "login"] }, description: "Topics mentioned" },
      priority: { type: "array", items: { enum: ["speed", "cost", "quality"] }, minItems: 3, maxItems: 3, uniqueItems: true },
      amount: { type: "number", description: "How much money is involved?", minimum: 0, maximum: 600, "x-unit": "EUR" },
      summary: { type: "string", description: "Summarise the request" },
      severity: { oneOf: [{ const: "low", description: "Can wait" }, { const: "high", description: "Blocks work" }], description: "Severity" },
      language: { anyOf: [{ $ref: "#/$defs/lang" }, { type: "null" }] },
    },
    $defs: { lang: { type: "string", enum: ["en", "de"], description: "Language of the ticket" } },
  };

  it("maps each property to a question type", () => {
    const r = parseQuestionFile("triage.schema.json", JSON.stringify(schema));
    expect(r.format).toBe("JSON Schema");
    expect(r.name).toBe("Ticket triage");
    expect(r.payload.context).toBe("Support tickets of a SaaS company.");
    expect(kinds(r)).toEqual(["choice", "noul", "score", "multi", "rank", "number", "text", "choice", "choice"]);
    const q = r.payload.questions;
    expect(q[0].text).toBe("Which team should handle this?");
    expect(q[0].options.map((o) => o.name)).toEqual(["billing", "technical", "account"]);
    expect(q[2].levels).toEqual(["1", "2", "3", "4", "5"]);
    expect(q[5].unit).toBe("EUR");
    expect(q[5].values.split(", ").length).toBeGreaterThanOrEqual(5);
    expect(q[7].options).toEqual([
      { name: "low", description: "Can wait" },
      { name: "high", description: "Blocks work" },
    ]);
    expect(q[8].text).toBe("Language of the ticket");
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("unwraps OpenAI structured-output wrappers", () => {
    const r = parseQuestionFile("x.json", JSON.stringify({ name: "triage", strict: true, schema: { type: "object", properties: { urgent: { type: "boolean" } } } }));
    expect(r.name).toBe("triage");
    expect(kinds(r)).toEqual(["noul"]);
    expect(r.payload.questions[0].text).toBe("Urgent");
  });
});

describe("JSON", () => {
  it("reads a loose list and infers types from options and wording", () => {
    const r = parseQuestionFile(
      "qs.json",
      JSON.stringify([
        { question: "Which department?", options: ["Sales", "Support", "HR"] },
        { question: "Is the customer angry?" },
        { question: "Satisfaction", choices: ["Very poor", "Poor", "Fair", "Good", "Excellent"] },
        { question: "Which features are mentioned?", options: [{ label: "export", description: "PDF or CSV export" }, { label: "sync" }], multiple: true },
        { question: "How many items were ordered?" },
        { question: "Anything else?" },
        { question: "Refund requested", type: "Yes/No" },
        { question: "Rank the causes", type: "ranking", options: "price; delay; quality" },
        { prompt: "Approved?", options: ["Yes", "No"] },
        { foo: "no text" },
      ]),
    );
    expect(r.format).toBe("JSON list");
    expect(kinds(r)).toEqual(["choice", "noul", "score", "multi", "number", "text", "noul", "rank", "noul"]);
    expect(r.payload.questions[3].options[0]).toEqual({ name: "export", description: "PDF or CSV export" });
    expect(r.payload.questions[7].options.map((o) => o.name)).toEqual(["price", "delay", "quality"]);
    expect(r.notes.some((n) => n.includes("1 item without question text skipped"))).toBe(true);
  });

  it("reads Ollaya / TypeSafe question maps", () => {
    const r = parseQuestionFile(
      "preset.json",
      JSON.stringify({
        intent: { type: "choice", instructions: "What does the customer want?", criteria: { refund: "Money back", fix: null } },
        is_urgent: { type: "noul", instructions: "The ticket is urgent.", criteria: { true: "Deadline today" } },
        frustration: { type: "score", criteria: ["calm", "annoyed", "furious"] },
      }),
    );
    expect(r.format).toBe("Ollaya / TypeSafe questions");
    expect(kinds(r)).toEqual(["choice", "noul", "score"]);
    expect(r.payload.questions[0].options).toEqual([
      { name: "refund", description: "Money back" },
      { name: "fix", description: "" },
    ]);
    expect(r.payload.questions[1].yes).toBe("Deadline today");
    expect(r.payload.questions[2].text).toBe("Frustration");
    expect(r.payload.questions[2].levels).toEqual(["calm", "annoyed", "furious"]);
  });

  it("round-trips ClassifAI's own payload", () => {
    const payload = { context: "ctx", questions: [{ kind: "choice", text: "Q", context: "", options: [{ name: "a", description: "" }, { name: "b", description: "" }], threshold: 0.5, yes: "", no: "", levels: [], values: "", unit: "" }] };
    const r = parseQuestionFile("set.json", JSON.stringify(payload));
    expect(r.format).toBe("ClassifAI question set");
    expect(r.payload).toEqual(payload);
  });

  it("reads { name, context, questions } and question→options maps", () => {
    const a = parseQuestionFile("a.json", JSON.stringify({ name: "Screening", context: "RCTs only", questions: ["Is it an RCT?", "Which population?"] }));
    expect([a.name, a.payload.context, ...kinds(a)]).toEqual(["Screening", "RCTs only", "noul", "text"]);
    const b = parseQuestionFile("b.json", JSON.stringify({ "Which colour?": ["red", "green"], urgent: ["yes", "no"] }));
    expect(kinds(b)).toEqual(["choice", "noul"]);
    expect(b.payload.questions[1].text).toBe("Urgent");
  });
});

describe("CSV", () => {
  it("one row per question, options in a cell", () => {
    const csv = 'id,question,type,options,context\n1,Which team?,,"billing; technical; account",Route by need\n2,Is it urgent?,,,\n3,Rate the tone,,"1|2|3|4|5",\n4,Tags,multi,"a,b,c",\n5,Notes,,,';
    const r = parseQuestionFile("qs.csv", csv);
    expect(r.format).toBe("CSV (one row per question)");
    expect(kinds(r)).toEqual(["choice", "noul", "score", "multi", "text"]);
    expect(r.payload.questions[0].context).toBe("Route by need");
    expect(r.payload.questions[2].levels).toEqual(["1", "2", "3", "4", "5"]);
    expect(r.name).toBe("qs");
  });

  it("one row per option, question repeated or left blank", () => {
    const csv = "label,question,description\nbilling,Which team?,Money\ntechnical,,Bugs\naccount,Which team?,Login\nyes,Refund?,\nno,Refund?,";
    const r = parseQuestionFile("long.csv", csv);
    expect(r.format).toBe("CSV (one row per option)");
    expect(kinds(r)).toEqual(["choice", "noul"]);
    expect(r.payload.questions[0].options).toEqual([
      { name: "billing", description: "Money" },
      { name: "technical", description: "Bugs" },
      { name: "account", description: "Login" },
    ]);
  });

  it("parses quotes, doubled quotes, newlines and semicolon CSVs", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi""\nthen"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"\nthen'],
    ]);
    expect(parseCsv("question;options\nWhich?;a|b\n")).toEqual([
      ["question", "options"],
      ["Which?", "a|b"],
    ]);
  });

  it("explains a missing question column", () => {
    expect(() => parseQuestionFile("x.csv", "foo,bar\n1,2")).toThrow(/No question column/);
  });
});

describe("number candidates", () => {
  it("uses a 1-2-5 series across orders of magnitude, round steps otherwise", () => {
    expect(candidateValues(0, 5000)).toEqual([0, 10, 50, 100, 500, 1000, 5000]);
    expect(candidateValues(0, 600)).toEqual([0, 1, 5, 10, 50, 100, 500, 600]);
    expect(candidateValues(0, 60)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(candidateValues(18, 90)).toEqual([18, 20, 40, 60, 80, 90]);
  });
});
