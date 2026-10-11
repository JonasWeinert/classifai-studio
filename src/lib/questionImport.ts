// Import question sets from JSON, CSV or JSON Schema. Everything is deterministic: explicit type
// words win; otherwise the options decide (yes/no pair, ordered scale, numbers), then the wording of
// the question (yes/no questions, "how many"), then free text. Every guess is reported in `notes`.
import type { QuestionSetPayload, SetQuestion } from "./types";

type Kind = SetQuestion["kind"];

export interface ImportedSet {
  /** What the file looked like, e.g. "JSON Schema". */
  format: string;
  name: string | null;
  description: string | null;
  payload: QuestionSetPayload;
  /** One line per question whose type was inferred or that needed fixing, plus skipped items. */
  notes: string[];
}

const blank = (kind: Kind, text: string): SetQuestion => ({
  kind,
  text,
  context: "",
  options: [],
  threshold: 0.5,
  yes: "",
  no: "",
  levels: [],
  values: "",
  unit: "",
});

// ---- type words -----------------------------------------------------------------------------------

const SYNONYMS: [Kind, string[]][] = [
  ["multi", ["multi", "multiple", "multi_choice", "multiple_choice_multiple", "multiselect", "multi_select", "checkbox", "checkboxes", "multilabel", "multi_label", "tags", "pick_any", "select_all", "any"]],
  ["choice", ["choice", "single", "single_choice", "singlechoice", "select", "dropdown", "categorical", "category", "classification", "class", "enum", "radio", "label", "pick_one", "one", "multiple_choice", "mcq"]],
  ["noul", ["noul", "boolean", "bool", "yes_no", "yesno", "binary", "true_false", "truefalse", "predicate", "statement", "flag"]],
  ["score", ["score", "scale", "likert", "rating", "rate", "ordinal", "level", "stars"]],
  ["rank", ["rank", "ranking", "order", "ordering", "sort", "priority_order"]],
  ["number", ["number", "numeric", "integer", "int", "float", "decimal", "count", "amount", "quantity", "estimate"]],
  ["text", ["text", "free_text", "freetext", "open", "open_ended", "openended", "string", "essay", "short_answer", "long_answer", "comment", "free"]],
];

/** A type word, normalised: "Pick one" -> "pick_one". */
function kindFromWord(word: unknown): Kind | null {
  if (typeof word !== "string" || !word.trim()) return null;
  const w = word.trim().toLowerCase().replace(/[\s/\-]+/g, "_");
  for (const [k, words] of SYNONYMS) if (words.includes(w)) return k;
  return null;
}

// ---- option shapes --------------------------------------------------------------------------------

const YES = ["yes", "y", "true", "t", "1", "ja", "si", "oui"];
const NO = ["no", "n", "false", "f", "0", "nein", "non"];
const LIKERT = [
  ["strongly disagree", "disagree", "neutral", "agree", "strongly agree"],
  ["never", "rarely", "sometimes", "often", "always"],
  ["very low", "low", "medium", "high", "very high"],
  ["low", "medium", "high"],
  ["none", "low", "medium", "high"],
  ["very poor", "poor", "fair", "good", "excellent"],
  ["poor", "fair", "good", "very good", "excellent"],
  ["not at all", "slightly", "moderately", "very", "extremely"],
];

const isYesNo = (opts: string[]) => {
  const l = opts.map((o) => o.trim().toLowerCase());
  return l.length === 2 && l.some((o) => YES.includes(o)) && l.some((o) => NO.includes(o));
};
const isNumeric = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));
/** An ordered scale: consecutive integers, or a known Likert wording (in either direction, any subset of 3+). */
function isScale(opts: string[]) {
  if (opts.length < 2 || opts.length > 10) return false;
  if (opts.every(isNumeric)) {
    const n = opts.map(Number);
    return n.every(Number.isInteger) && n.every((v, i) => i === 0 || Math.abs(v - n[i - 1]) === 1);
  }
  const l = opts.map((o) => o.trim().toLowerCase());
  return LIKERT.some((scale) => {
    const fwd = l.map((o) => scale.indexOf(o));
    return l.length >= 3 && fwd.every((i) => i >= 0) && (fwd.every((v, i) => i === 0 || v > fwd[i - 1]) || fwd.every((v, i) => i === 0 || v < fwd[i - 1]));
  });
}

const YES_NO_START = /^(is|are|was|were|does|do|did|has|have|had|can|could|should|would|will|must|may)\b/i;
const NUMBER_START = /^(how (many|much|long|old|often)|what (is|was) the (number|amount|count|age|price|cost|year)|in what year)\b/i;

interface Raw {
  text: string;
  kind: Kind | null;
  options: { name: string; description: string }[];
  multiple?: boolean;
  context?: string;
  values?: number[];
  unit?: string;
  min?: number;
  max?: number;
  threshold?: number;
  yes?: string;
  no?: string;
}

/** Decide a question's type and fill its draft. Returns the question and a note when the type was inferred. */
function finish(r: Raw, where: string): { q: SetQuestion; note: string | null } {
  const opts = r.options.filter((o) => o.name.trim());
  const names = opts.map((o) => o.name.trim());
  let kind = r.kind;
  let why = "";
  if (!kind) {
    if (names.length && r.multiple) [kind, why] = ["multi", "allows several options"];
    else if (isYesNo(names)) [kind, why] = ["noul", "options are yes/no"];
    else if (isScale(names)) [kind, why] = ["score", "options form an ordered scale"];
    else if (names.length >= 2 && names.every(isNumeric)) [kind, why] = ["number", "options are numbers"];
    else if (names.length >= 2) [kind, why] = ["choice", `${names.length} options`];
    else if (r.values?.length || r.min !== undefined || r.max !== undefined) [kind, why] = ["number", "has numeric values"];
    else if (NUMBER_START.test(r.text.trim())) [kind, why] = ["number", "asks for a number"];
    else if (YES_NO_START.test(r.text.trim())) [kind, why] = ["noul", "reads as a yes/no question"];
    else [kind, why] = ["text", "no options"];
  }
  // Types that need options fall back when there are none.
  if ((kind === "choice" || kind === "multi" || kind === "rank") && names.length < (kind === "multi" ? 1 : 2)) {
    why = `${kind} without options, so free text`;
    kind = "text";
  }
  const q = blank(kind, r.text.trim());
  q.context = (r.context ?? "").trim();
  if (kind === "choice" || kind === "multi" || kind === "rank") q.options = opts.map((o) => ({ name: o.name.trim(), description: o.description.trim() }));
  if (kind === "multi" && r.threshold !== undefined) q.threshold = r.threshold;
  if (kind === "noul") {
    const yes = opts.find((o) => YES.includes(o.name.trim().toLowerCase()));
    const no = opts.find((o) => NO.includes(o.name.trim().toLowerCase()));
    q.yes = (r.yes ?? yes?.description ?? "").trim();
    q.no = (r.no ?? no?.description ?? "").trim();
  }
  if (kind === "score") {
    if (names.length >= 2) q.levels = names;
    else if (r.min !== undefined && r.max !== undefined && Number.isInteger(r.min) && Number.isInteger(r.max) && r.max > r.min && r.max - r.min <= 9) {
      q.levels = Array.from({ length: r.max - r.min + 1 }, (_, i) => String(r.min! + i));
    } else q.levels = ["Low", "Medium", "High"];
  }
  if (kind === "number") {
    let values = r.values?.length ? r.values : names.filter(isNumeric).map(Number);
    if (values.length < 2 && r.min !== undefined && r.max !== undefined && r.max > r.min) values = candidateValues(r.min, r.max);
    q.values = (values.length ? [...new Set(values)].sort((a, b) => a - b) : [0, 1, 5, 10, 50, 100]).join(", ");
    q.unit = (r.unit ?? "").trim();
  }
  return { q, note: r.kind ? (why ? `${where}: ${why}` : null) : `${where}: ${KIND_LABEL[kind]} — ${why}` };
}

/** Round candidate values for a range: a 1-2-5 series when it spans orders of magnitude, else ~7 even, rounded steps. */
export function candidateValues(min: number, max: number): number[] {
  const out = new Set<number>([min]);
  if (min >= 0 && max / Math.max(min, 1) >= 100) {
    const top = Math.ceil(Math.log10(max));
    const from = Math.max(Math.floor(Math.log10(Math.max(min, 1))), top - 3);
    const steps = top - from >= 3 ? [1, 5] : [1, 2, 5];
    for (let e = from; e <= top; e++) {
      for (const m of steps) {
        const v = m * 10 ** e;
        if (v > min && v < max) out.add(v);
      }
    }
    const all = [...out].sort((a, b) => a - b);
    // Keep about eight: thin the middle evenly.
    const keep = all.length <= 8 ? all : Array.from({ length: 7 }, (_, i) => all[Math.round((i * (all.length - 1)) / 6)]);
    return [...new Set([...keep, max])];
  }
  const raw = (max - min) / 6;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  for (let v = Math.ceil(min / step) * step; v < max; v += step) out.add(Number(v.toPrecision(6)));
  out.add(max);
  return [...out].sort((a, b) => a - b);
}

const KIND_LABEL: Record<Kind, string> = { choice: "Pick one", multi: "Pick any", noul: "Yes / No", score: "Scale", rank: "Rank", number: "Number", text: "Free text" };

const humanize = (key: string) => {
  const s = key.replace(/[_\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const hit = Object.keys(o).find((x) => x.toLowerCase().replace(/[\s_-]/g, "") === k);
    if (hit !== undefined && o[hit] !== undefined && o[hit] !== null && o[hit] !== "") return o[hit];
  }
  return undefined;
};

const TEXT_KEYS = ["question", "text", "prompt", "title", "label", "statement", "instructions", "instruction", "name", "q"];
const TYPE_KEYS = ["type", "kind", "questiontype", "answertype", "format", "responsetype", "inputtype"];
const OPTION_KEYS = ["options", "choices", "labels", "categories", "answers", "values", "enum", "criteria", "levels", "items", "classes"];
const CONTEXT_KEYS = ["context", "guidance", "description", "help", "hint", "note", "notes", "details", "definition", "instructions"];

/** Options from a list of strings, `{name, description}` objects, or a `{name: description}` map. */
function optionsOf(v: unknown): { name: string; description: string }[] {
  if (Array.isArray(v)) {
    return v
      .map((o) => {
        if (o && typeof o === "object") {
          const r = o as Record<string, unknown>;
          return { name: str(pick(r, ["name", "label", "value", "option", "choice", "title", "id", "const", "key"])), description: str(pick(r, ["description", "desc", "definition", "meaning", "help", "criteria", "explanation"])) };
        }
        return { name: str(o), description: "" };
      })
      .filter((o) => o.name);
  }
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([name, d]) => ({ name, description: str(d) }));
  if (typeof v === "string" && v.trim()) return splitList(v).map((name) => ({ name, description: "" }));
  return [];
}

/** "a; b; c", "a | b", "a, b" (commas only when there are no semicolons or pipes) or one per line. */
function splitList(s: string): string[] {
  const sep = s.includes("\n") ? /\n/ : s.includes(";") ? /;/ : s.includes("|") ? /\|/ : /,/;
  return s.split(sep).map((x) => x.trim()).filter(Boolean);
}

// ---- JSON -----------------------------------------------------------------------------------------

function fromLooseObject(o: Record<string, unknown>, where: string, fallbackText = ""): { q: SetQuestion; note: string | null } | null {
  const text = str(pick(o, TEXT_KEYS)) || fallbackText;
  if (!text) return null;
  const typeWord = pick(o, TYPE_KEYS);
  let kind = kindFromWord(typeWord);
  const multiple = pick(o, ["multiple", "allowmultiple", "multiselect", "multi"]) === true || Number(pick(o, ["maxselections", "maxselect", "maxchoices"]) ?? 0) > 1;
  if (kind === "choice" && multiple) kind = "multi";
  const rawOptions = pick(o, OPTION_KEYS);
  // Wire criteria for yes/no: { true: "...", false: "..." }.
  const crit = o.criteria as Record<string, unknown> | undefined;
  const boolCrit = crit && !Array.isArray(crit) && typeof crit === "object" && Object.keys(crit).every((k) => k === "true" || k === "false");
  const contextKey = pick(o, CONTEXT_KEYS.filter((k) => str(pick(o, [k])) !== text));
  const num = (k: string[]) => {
    const v = pick(o, k);
    return v === undefined || !isNumeric(str(v)) ? undefined : Number(v);
  };
  const values = Array.isArray(o.values) && o.values.every((x) => isNumeric(str(x))) ? (o.values as unknown[]).map(Number) : undefined;
  return finish(
    {
      text,
      kind,
      options: boolCrit ? [{ name: "yes", description: str(crit!.true) }, { name: "no", description: str(crit!.false) }] : values ? [] : optionsOf(rawOptions),
      multiple,
      context: str(contextKey),
      values,
      unit: str(pick(o, ["unit", "units"])),
      min: num(["min", "minimum", "from", "low"]),
      max: num(["max", "maximum", "to", "high"]),
      threshold: num(["threshold"]),
      yes: str(pick(o, ["yes", "true", "yesmeans"])) || undefined,
      no: str(pick(o, ["no", "false", "nomeans"])) || undefined,
    },
    where,
  );
}

function isOurPayload(v: unknown): v is QuestionSetPayload & { name?: string; description?: string } {
  const q = (v as QuestionSetPayload)?.questions;
  return Array.isArray(q) && q.length > 0 && q.every((x) => x && typeof x === "object" && "kind" in x && "options" in x && "levels" in x);
}

function isJsonSchema(v: Record<string, unknown>): boolean {
  return typeof v.$schema === "string" || (v.type === "object" && typeof v.properties === "object") || (typeof v.properties === "object" && !Array.isArray(v.properties));
}

/** `{ id: { type: "choice" | "noul" | ..., instructions, criteria } }` — Ollaya / TypeSafe questions. */
function isWireMap(v: Record<string, unknown>): boolean {
  const vals = Object.values(v);
  return vals.length > 0 && vals.every((x) => x && typeof x === "object" && !Array.isArray(x) && typeof (x as Record<string, unknown>).type === "string" && ["choice", "noul", "score", "multi", "rank", "number"].includes((x as Record<string, string>).type));
}

function fromJson(data: unknown): ImportedSet {
  const notes: string[] = [];
  const done = (format: string, qs: ({ q: SetQuestion; note: string | null } | null)[], meta: { name?: unknown; description?: unknown; context?: unknown } = {}): ImportedSet => {
    const ok = qs.filter((x): x is { q: SetQuestion; note: string | null } => !!x);
    ok.forEach((x) => x.note && notes.push(x.note));
    if (qs.length > ok.length) notes.push(`${qs.length - ok.length} item${qs.length - ok.length === 1 ? "" : "s"} without question text skipped`);
    return { format, name: str(meta.name) || null, description: str(meta.description) || null, payload: { context: str(meta.context), questions: ok.map((x) => x.q) }, notes };
  };

  if (isOurPayload(data)) {
    const d = data as QuestionSetPayload & { name?: string; description?: string };
    return { format: "ClassifAI question set", name: d.name ?? null, description: d.description ?? null, payload: { context: d.context ?? "", questions: d.questions.map((q) => ({ ...blank(q.kind, q.text), ...q })) }, notes };
  }
  if (Array.isArray(data)) {
    return done("JSON list", data.map((x, i) => (x && typeof x === "object" ? fromLooseObject(x as Record<string, unknown>, `Question ${i + 1}`) : typeof x === "string" ? finish({ text: x, kind: null, options: [] }, `Question ${i + 1}`) : null)));
  }
  if (!data || typeof data !== "object") throw new Error("The file has no questions: expected a list, an object of questions or a JSON Schema.");
  const o = data as Record<string, unknown>;

  // Wrappers: { name, schema }, { json_schema: { schema } }, { response_format: { json_schema } }, { parameters } (tools).
  const inner = (o.json_schema as Record<string, unknown>)?.schema ?? (o.response_format as { json_schema?: { schema?: unknown } })?.json_schema?.schema ?? (typeof o.schema === "object" ? o.schema : undefined) ?? (typeof o.parameters === "object" ? o.parameters : undefined);
  if (inner && typeof inner === "object" && isJsonSchema(inner as Record<string, unknown>)) {
    const r = fromSchema(inner as Record<string, unknown>);
    return { ...r, name: r.name ?? (str(o.name) || str((o.json_schema as Record<string, unknown>)?.name) || null), description: r.description ?? (str(o.description) || null) };
  }
  if (isJsonSchema(o)) return fromSchema(o);
  if (isWireMap(o)) {
    return done(
      "Ollaya / TypeSafe questions",
      Object.entries(o).map(([id, q]) => {
        const w = q as Record<string, unknown>;
        return fromLooseObject({ ...w, text: str(w.instructions) || humanize(id), instructions: undefined }, humanize(id));
      }),
    );
  }
  // { name?, context?, questions: [...] } with loose questions.
  const list = pick(o, ["questions", "items", "fields", "prompts", "tasks"]);
  if (Array.isArray(list)) {
    const meta = { name: pick(o, ["name", "title"]), description: pick(o, ["description"]), context: pick(o, ["context", "sharedcontext", "instructions", "guidelines"]) };
    return done("JSON", list.map((x, i) => (x && typeof x === "object" ? fromLooseObject(x as Record<string, unknown>, `Question ${i + 1}`) : typeof x === "string" ? finish({ text: x, kind: null, options: [] }, `Question ${i + 1}`) : null)), meta);
  }
  // { "Question text": ["opt", ...] } or { key: { ...question } }
  return done(
    "JSON object",
    Object.entries(o).map(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v) ? fromLooseObject(v as Record<string, unknown>, humanize(k), humanize(k)) : finish({ text: k.includes(" ") ? k : humanize(k), kind: null, options: optionsOf(v) }, humanize(k)),
    ),
  );
}

// ---- JSON Schema ----------------------------------------------------------------------------------

function fromSchema(root: Record<string, unknown>): ImportedSet {
  const notes: string[] = [];
  const defs = { ...((root.$defs as object) ?? {}), ...((root.definitions as object) ?? {}) } as Record<string, Record<string, unknown>>;
  const resolve = (s: Record<string, unknown>, seen = 0): Record<string, unknown> => {
    const ref = typeof s.$ref === "string" ? s.$ref : null;
    if (!ref || seen > 8) return s;
    const target = defs[ref.replace(/^#\/(\$defs|definitions)\//, "")];
    return target ? resolve({ ...target, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$ref")) }, seen + 1) : s;
  };
  const props = (root.properties ?? {}) as Record<string, Record<string, unknown>>;
  const questions: SetQuestion[] = [];
  for (const [key, raw] of Object.entries(props)) {
    let p = resolve(raw ?? {});
    // Nullable: anyOf [X, {type: null}].
    const variants = (p.anyOf ?? p.oneOf) as Record<string, unknown>[] | undefined;
    const consts = variants?.filter((v) => v && "const" in resolve(v));
    let options: { name: string; description: string }[] = [];
    if (variants && consts && consts.length >= 2) {
      options = consts.map((v) => {
        const r = resolve(v);
        return { name: str(r.const), description: str(r.description ?? r.title) };
      });
    } else if (variants) {
      const nonNull = variants.map((v) => resolve(v)).filter((v) => v.type !== "null");
      if (nonNull.length === 1) p = { ...nonNull[0], ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== "anyOf" && k !== "oneOf")) };
    }
    const types = Array.isArray(p.type) ? (p.type as string[]).filter((t) => t !== "null") : [str(p.type)];
    const type = types[0] ?? "";
    const text = str(p.description) || str(p.title) || humanize(key);
    const context = p.description && p.title ? str(p.description) : str(p["x-context"] ?? p.$comment);
    const where = humanize(key);
    const explicit = kindFromWord(p["x-kind"] ?? p["x-question-type"]);
    let r: Raw;
    if (type === "array") {
      const items = resolve((p.items ?? {}) as Record<string, unknown>);
      const itemOpts = Array.isArray(items.enum) ? (items.enum as unknown[]).map((e) => ({ name: str(e), description: "" })) : optionsOf(((items.anyOf ?? items.oneOf) as unknown[] | undefined)?.map((v) => resolve(v as Record<string, unknown>)).map((v) => ({ name: str(v.const), description: str(v.description ?? v.title) })));
      const n = itemOpts.length;
      const permutation = n >= 2 && p.minItems === n && p.maxItems === n && p.uniqueItems === true;
      r = { text, kind: explicit ?? (permutation ? "rank" : itemOpts.length ? "multi" : "text"), options: itemOpts, context };
      if (!explicit) notes.push(`${where}: ${permutation ? "Rank — a list holding every option once" : itemOpts.length ? "Pick any — a list of allowed values" : "Free text — a list without fixed values"}`);
    } else if (Array.isArray(p.enum) || options.length) {
      const opts = options.length ? options : (p.enum as unknown[]).filter((e) => e !== null).map((e) => ({ name: str(e), description: "" }));
      const res = finish({ text, kind: explicit, options: opts, context }, where);
      questions.push(res.q);
      if (res.note) notes.push(res.note);
      continue;
    } else if (type === "boolean") {
      r = { text, kind: explicit ?? "noul", options: [], context };
      if (!explicit) notes.push(`${where}: Yes / No — a boolean`);
    } else if (type === "integer" || type === "number") {
      const min = typeof p.minimum === "number" ? p.minimum : undefined;
      const max = typeof p.maximum === "number" ? p.maximum : undefined;
      const small = type === "integer" && min !== undefined && max !== undefined && max - min >= 1 && max - min <= 9;
      const examples = Array.isArray(p.examples) ? (p.examples as unknown[]).filter((x) => isNumeric(str(x))).map(Number) : undefined;
      r = { text, kind: explicit ?? (small ? "score" : "number"), options: [], context, min, max, values: examples, unit: str(p["x-unit"] ?? p.unit) };
      if (!explicit) notes.push(`${where}: ${small ? `Scale — whole numbers ${min}–${max}` : "Number"}`);
    } else if (type === "string" || type === "") {
      r = { text, kind: explicit ?? "text", options: [], context };
      if (!explicit) notes.push(`${where}: Free text — a string without allowed values`);
    } else {
      notes.push(`${where}: skipped (a nested ${type})`);
      continue;
    }
    questions.push(finish(r, where).q);
  }
  if (!questions.length) throw new Error("The schema has no properties to turn into questions.");
  return { format: "JSON Schema", name: str(root.title) || null, description: str(root.description) || null, payload: { context: str(root.description), questions }, notes };
}

// ---- CSV ------------------------------------------------------------------------------------------

/** RFC 4180 CSV (quotes, doubled quotes, newlines in quotes); the delimiter is sniffed from the header. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t", "|"].reduce((best, d) => (first.split(d).length > first.split(best).length ? d : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function fromCsv(text: string): ImportedSet {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The CSV needs a header row and at least one question.");
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ""));
  // Keys in priority order: "question" beats "label" wherever the columns are.
  const col = (keys: string[]) => {
    for (const k of keys) {
      const i = header.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iText = col(TEXT_KEYS);
  if (iText < 0) throw new Error(`No question column: name one of question, text, prompt, title (found ${rows[0].join(", ")}).`);
  const iType = col(TYPE_KEYS);
  const iOpt = col(["option", "choice", "label", "answer", "value", "category", "level"].filter((k) => header.indexOf(k) !== iText));
  const iOpts = col(["options", "choices", "labels", "answers", "values", "categories", "levels"]);
  const iDesc = col(["description", "optiondescription", "meaning", "definition", "criteria"]);
  const iCtx = col(["context", "guidance", "help", "hint", "notes", "instructions"].filter((k) => header.indexOf(k) !== iText));
  const iUnit = col(["unit", "units"]);
  const iMulti = col(["multiple", "allowmultiple", "multiselect"]);
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const body = rows.slice(1);
  const notes: string[] = [];

  // Long format: one row per option, the question repeated (or left blank under its first row).
  const longFormat = iOpt >= 0 && iOpts < 0;
  const groups: { text: string; rows: string[][] }[] = [];
  for (const r of body) {
    const t = get(r, iText);
    if (longFormat && (!t || t === groups[groups.length - 1]?.text) && groups.length) groups[groups.length - 1].rows.push(r);
    else if (t) groups.push({ text: t, rows: [r] });
  }
  const questions = groups.map((g, i) => {
    const first = g.rows[0];
    const options = longFormat
      ? g.rows.map((r) => ({ name: get(r, iOpt), description: get(r, iDesc) })).filter((o) => o.name)
      : (() => {
          const names = splitList(get(first, iOpts));
          // Descriptions in a parallel list ("a; b" / "desc a; desc b"), else none.
          const descs = iDesc >= 0 ? splitList(get(first, iDesc)) : [];
          return names.map((n, k) => ({ name: n, description: descs.length === names.length ? descs[k] : "" }));
        })();
    const typeWord = g.rows.map((r) => get(r, iType)).find(Boolean);
    const multiple = ["yes", "true", "1", "y"].includes(get(first, iMulti).toLowerCase());
    let kind = kindFromWord(typeWord);
    if (kind === "choice" && multiple) kind = "multi";
    const numbers = options.length >= 2 && options.every((o) => isNumeric(o.name));
    const res = finish(
      {
        text: g.text,
        kind,
        options: kind === "number" ? [] : options,
        multiple,
        context: g.rows.map((r) => get(r, iCtx)).find(Boolean) ?? "",
        unit: get(first, iUnit),
        values: kind === "number" && numbers ? options.map((o) => Number(o.name)) : undefined,
      },
      `Row ${i + 2}${g.text.length > 40 ? "" : ` “${g.text}”`}`,
    );
    if (res.note) notes.push(res.note);
    return res.q;
  });
  if (!questions.length) throw new Error("No questions found in the CSV.");
  return { format: longFormat ? "CSV (one row per option)" : "CSV (one row per question)", name: null, description: null, payload: { context: "", questions }, notes };
}

// ---- entry point ----------------------------------------------------------------------------------

/** Parse a question file. `fileName` picks CSV vs JSON; content sniffing covers pasted text. */
export function parseQuestionFile(fileName: string, text: string): ImportedSet {
  const t = text.trim();
  if (!t) throw new Error("The file is empty.");
  const looksJson = t.startsWith("{") || t.startsWith("[");
  if (/\.(csv|tsv|txt)$/i.test(fileName) || !looksJson) {
    const r = fromCsv(t);
    return { ...r, name: r.name ?? (fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || null) };
  }
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  const r = fromJson(data);
  if (!r.payload.questions.length) throw new Error("No questions found in the file.");
  return { ...r, name: r.name ?? (fileName.replace(/\.(schema\.)?json$/i, "").replace(/[_-]+/g, " ").trim() || null) };
}
