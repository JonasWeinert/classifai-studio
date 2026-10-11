// In-memory backend for browser previews (`pnpm dev` outside Tauri). Not used in the app.
import type {
  CloudModel,
  Provider,
  UsageRow,
  AnyAnswer,
  AnyQuestion,
  CatalogModel,
  Dataset,
  EngineStatus,
  Experiment,
  ExperimentConfig,
  LocalModel,
  ModelMetrics,
  PredictionRow,
  Report,
  TaskSpec,
  Row,
} from "./types";

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();
function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((h) => h(payload));
}
export async function listen(event: string, cb: Handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)!.delete(cb);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seed = 42;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

// `?fresh` in the URL simulates a first launch: no engine, no models.
const fresh = typeof location !== "undefined" && new URLSearchParams(location.search).has("fresh");

const engine: EngineStatus = {
  installed: !fresh,
  binary_path: "~/Library/Application Support/dev.classifai.app/engine/bin/ollaya",
  managed: true,
  running: !fresh,
  owned_process: true,
  version: "0.9.2",
  base_url: "http://127.0.0.1:11435",
};

const catalog: CatalogModel[] = [
  { name: "laya", title: "Laya (router)", description: "Picks laya:en or laya:multilingual by language. Fast on any CPU — the best starting point.", kind: "encoder", params: "421M / 322M", approx_size_gb: 1.5, cpu_friendly: true, recommended: true, tags: ["fast", "multilingual"] },
  { name: "laya:en", title: "Laya English", description: "ModernBERT-large decision model. 8–10 ms for five questions on a GPU.", kind: "encoder", params: "421M", approx_size_gb: 0.85, cpu_friendly: true, recommended: false, tags: ["fast", "english"] },
  { name: "nli", title: "NLI zero-shot", description: "Moritz Laurer's DeBERTa-v3-large NLI classifier. A classic zero-shot baseline.", kind: "encoder", params: "DeBERTa-v3-L", approx_size_gb: 0.9, cpu_friendly: true, recommended: false, tags: ["baseline"] },
  { name: "gliclass", title: "GLiClass", description: "Knowledgator's instruction-following zero-shot classifier (DeBERTa-v3-large).", kind: "encoder", params: "DeBERTa-v3-L", approx_size_gb: 0.9, cpu_friendly: true, recommended: false, tags: ["baseline"] },
  { name: "winnow:e4b", title: "Winnow E4B", description: "Ollaya's recommended model: Gemma 4 fine-tune, 0.722 on typed-decisions. Best with a GPU (Metal works).", kind: "decoder", params: "4B", approx_size_gb: 8, cpu_friendly: false, recommended: true, tags: ["accurate"] },
  { name: "decider:0.8b", title: "Decider 0.8B", description: "Mapika's small Qwen3.5 decoder. A light decoder to compare against encoders.", kind: "decoder", params: "0.8B", approx_size_gb: 1, cpu_friendly: true, recommended: false, tags: ["small"] },
  { name: "clef", title: "Clef Flash", description: "Cloudflare's Qwen3.5-9B with a joint schema head: 0.703 accuracy, ECE 0.020.", kind: "decoder", params: "9B", approx_size_gb: 10, cpu_friendly: false, recommended: false, tags: ["accurate", "calibrated"] },
];

const installed: LocalModel[] = fresh ? [] : [
  { name: "laya:latest", modified_at: "2026-10-01T09:00:00Z", size: 11862, details: { format: "router", family: "laya", parameter_size: "", quantization_level: "" } },
  { name: "laya:en", modified_at: "2026-10-01T09:00:00Z", size: 845897529, details: { format: "onnx", family: "laya", parameter_size: "421M", quantization_level: "F32" } },
  { name: "nli:latest", modified_at: "2026-10-02T09:00:00Z", size: 870000000, details: { format: "onnx", family: "nli", parameter_size: "435M", quantization_level: "F32" } },
  { name: "decider:0.8b", modified_at: "2026-10-03T09:00:00Z", size: 1020000000, details: { format: "gguf", family: "decider", parameter_size: "0.8B", quantization_level: "Q8_0" } },
];

// ---- cloud providers --------------------------------------------------------------------------
const cm = (provider_id: string, model: string, display_name: string, description: string, input: number, enabled = true): CloudModel => ({
  id: `@${provider_id}/${model}`, provider_id, model, display_name, description, input_price_per_mtok: input, output_price_per_mtok: 0, enabled, builtin: true, default_input_price_per_mtok: input, default_output_price_per_mtok: 0,
});
const providers: Provider[] = [
  { id: "typesafe", kind: "typesafe", name: "TypeSafe Jev", base_url: null, account_id: null, has_key: true, key_hint: "…a91f", builtin: true,
    models: [cm("typesafe", "jev-latest", "Jev", "TypeSafe's hosted System One model — the reference decision model.", 0.042)] },
  { id: "openai", kind: "openai", name: "OpenAI Decisions", base_url: null, account_id: null, has_key: false, key_hint: null, builtin: true,
    models: [cm("openai", "gpt-6-luna", "GPT-6 Luna", "OpenAI's Decisions API (beta). Predicates, choices and scores with probabilities.", 0.1)] },
  { id: "cloudflare", kind: "cloudflare", name: "Cloudflare Workers AI", base_url: null, account_id: null, has_key: false, key_hint: null, builtin: true,
    models: [cm("cloudflare", "clef-flash", "Clef Flash", "Cloudflare's 9B Clef with a joint schema head. 65k context.", 0.09), cm("cloudflare", "clef", "Clef", "The 27B Clef. Higher accuracy, 65k context, reads images.", 0.24, false)] },
  { id: "anthropic", kind: "anthropic", name: "Anthropic", base_url: null, account_id: null, has_key: true, key_hint: "…7c2e", builtin: true,
    models: [{ ...cm("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", "Fast, inexpensive LLM; answers through structured output.", 1), output_price_per_mtok: 5, default_output_price_per_mtok: 5 }] },
  { id: "openai-chat", kind: "chat", name: "OpenAI (LLM)", base_url: null, account_id: null, has_key: false, key_hint: null, builtin: true, models: [] },
];
const usageLog: { model: string; tokens: number; cost: number; exp?: string }[] = [
  { model: "@typesafe/jev-latest", tokens: 182_400, cost: 0.0077 },
  { model: "laya:latest", tokens: 96_000, cost: 0 },
];
/** LLMs quote a supporting passage: here a sentence of the input (slightly reworded for the second question, to show a close match). */
const llmQuotes = (model: string, q: Record<string, unknown>, state: string) => {
  if (!model.startsWith("@anthropic/") && !providers.some((p) => p.kind === "chat" && model.startsWith(`@${p.id}/`))) return undefined;
  const sentences = String(state).split(/(?<=[.!?])\s+/).filter(Boolean);
  return Object.fromEntries(Object.keys(q).map((id, i) => [id, i === 1 ? (sentences[0] ?? "").replace(/\btwice\b/, "two times") : i === 2 ? "" : sentences[i % Math.max(1, sentences.length)] ?? ""]));
};
const cloudFor = (id: string) => providers.flatMap((p) => p.models).find((m) => m.id === id);

// ---- demo dataset ---------------------------------------------------------------------------
const departments = ["billing", "technical", "account", "shipping"];
const phrases: Record<string, string[]> = {
  billing: ["I was charged twice this month", "Please refund my last invoice", "Why did my subscription price go up?", "The VAT on my receipt is wrong", "Cancel my plan and refund the remainder"],
  technical: ["The app crashes when I upload a photo", "Sync has been failing since yesterday", "I get error 502 on the dashboard", "Notifications stopped working on Android", "Export to PDF produces a blank page"],
  account: ["I can't log in after resetting my password", "Please change the email on my account", "How do I enable two-factor authentication?", "My account was locked for no reason", "Merge my two accounts please"],
  shipping: ["My package hasn't arrived after 10 days", "Tracking says delivered but nothing came", "Can I change the delivery address?", "The box arrived damaged", "Do you ship to Norway?"],
};
const tails = ["", " Thanks.", " This is urgent!", " Order #48213.", " Please help asap.", " I've been a customer for years."];
const demoRows: Row[] = Array.from({ length: 160 }, (_, i) => {
  const d = departments[i % 4];
  const p = phrases[d][Math.floor(rand() * 5)];
  const t = tails[Math.floor(rand() * tails.length)];
  return { id: String(1000 + i), subject: p.split(" ").slice(0, 4).join(" ") + "…", body: p + "." + t, department: i === 148 || i === 152 ? "Billing " : i === 156 ? "billing." : d, priority: rand() > 0.7 ? "high" : "normal" };
});

const datasets: Dataset[] = [
  { id: "ds-demo", name: "support_tickets", source: "/demo/support_tickets.csv", columns: ["id", "subject", "body", "department", "priority"], row_count: demoRows.length, created_at: "2026-10-05T10:00:00Z" },
];
const rowsByDataset: Record<string, Row[]> = { "ds-demo": demoRows };

// ---- experiments -----------------------------------------------------------------------------
interface Pred { model: string; q: string; row_idx: number; gt: string; predicted: string | null; confidence: number | null; top: number | null; latency: number; error: string | null }
const experiments: Experiment[] = [];
const preds: Record<string, Pred[]> = {};
const skill: Record<string, number> = { "@typesafe/jev-latest": 0.93, "laya": 0.86, "laya:en": 0.88, "nli": 0.71, "decider:0.8b": 0.64, "winnow:e4b": 0.91 };
const speed: Record<string, number> = { "@typesafe/jev-latest": 260, "laya": 140, "laya:en": 120, "nli": 210, "decider:0.8b": 900, "winnow:e4b": 1600 };

function fakePred(model: string, q: string, labels: string[], gt: string, idx: number): Pred {
  const s = skill[model] ?? 0.75;
  const hit = rand() < s;
  const predicted = hit ? gt : labels.filter((l) => l !== gt)[Math.floor(rand() * (labels.length - 1))] ?? gt;
  const top = hit ? 0.55 + rand() * 0.45 : 0.35 + rand() * 0.45;
  return { model, q, row_idx: idx, gt, predicted, confidence: Math.max(0, (labels.length * top - 1) / (labels.length - 1)), top, latency: (speed[model] ?? 300) * (0.7 + rand() * 0.6), error: null };
}

const gtOf = (row: Row, t: TaskSpec) => {
  const v = (row[t.label_column] ?? "").trim();
  return t.labels.find((l) => l.value === v || l.aliases?.includes(v))?.value ?? null;
};

function predictRow(id: string, e: Experiment, m: string, i: number) {
  const row = rowsByDataset[e.dataset_id][i];
  for (const t of e.config.tasks) {
    const gt = gtOf(row, t);
    if (gt !== null) preds[id].push(fakePred(m, t.id, t.labels.map((l) => l.value), gt, i));
  }
}

function seedExperiment(name: string, models: string[], n: number) {
  const config: ExperimentConfig = {
    name,
    dataset_id: "ds-demo",
    input_columns: ["subject", "body"],
    context: "Support tickets from an online shop.",
    tasks: [
      { id: "department", kind: "choice", instructions: "Which team should handle this support ticket?", label_column: "department", labels: departments.map((d) => ({ value: d, description: null })) },
      { id: "priority", kind: "binary", instructions: "This ticket is high priority.", label_column: "priority", labels: [{ value: "high" }, { value: "normal" }], positive_label: "high" },
    ],
    models,
    sample_size: n,
  };
  const id = `exp-${experiments.length + 1}`;
  const idx = Array.from({ length: n }, (_, i) => i);
  const e: Experiment = {
    id, name, dataset_id: "ds-demo", dataset_name: "support_tickets", config,
    status: "completed", error: null, row_indices: idx,
    progress: Object.fromEntries(models.map((m) => [m, n])),
    created_at: new Date(Date.now() - 3600_000 * (experiments.length + 1)).toISOString(),
    finished_at: new Date().toISOString(),
  };
  preds[id] = [];
  models.forEach((m) => idx.forEach((i) => predictRow(id, e, m, i)));
  experiments.unshift(e);
  return id;
}
seedExperiment("Routing baseline", ["laya", "nli", "decider:0.8b", "@typesafe/jev-latest"], 120);
seedExperiment("Routing v2 (with context)", ["laya", "nli", "@typesafe/jev-latest"], 120);
usageLog.push({ model: "@typesafe/jev-latest", tokens: 120 * 140, cost: (120 * 140 * 0.042) / 1e6, exp: "exp-1" }, { model: "laya", tokens: 120 * 140, cost: 0, exp: "exp-1" });

/** Cohen's kappa approximation with a uniform chance rate (mock only). */
const kappaFrom = (agree: number, k: number) => (agree - 1 / k) / (1 - 1 / k);

const corrections: { dataset: string; row_idx: number; column: string; original: string; value: string; note: string | null; at: string }[] = [];
const questionSets: { id: string; name: string; description: string; version: number; payload: any; updated_at: string }[] = [
  {
    id: "transactions", name: "Transaction coding", description: "Category + recurring for bank transactions", version: 2, updated_at: new Date(Date.now() - 864e5).toISOString(),
    payload: { context: "Bank transactions from a German personal account, amounts in EUR.", questions: [
      { kind: "choice", text: "Which spending category is this?", context: "", options: [{ name: "groceries", description: "Supermarkets and food shopping" }, { name: "software", description: "Apps, SaaS and subscriptions to digital tools" }, { name: "dining", description: "Restaurants, cafés, delivery" }], threshold: 0.5, yes: "", no: "", levels: [], values: "", unit: "" },
      { kind: "noul", text: "This is a recurring payment.", context: "", options: [], threshold: 0.5, yes: "Subscription, rent, contract or regular bill", no: "One-off purchase", levels: [], values: "", unit: "" },
    ] },
  },
];
let settings = { monthly_budget_usd: 5 as number | null, budget_hard_stop: false };

function report(e: Experiment, question?: string): Report {
  const task = e.config.tasks.find((t) => t.id === question) ?? e.config.tasks[0];
  const labels = task.labels.map((l) => l.value);
  const ps = (preds[e.id] ?? []).filter((p) => p.q === task.id);
  const models: ModelMetrics[] = e.config.models.map((m) => {
    const mp = ps.filter((p) => p.model === m);
    const ok = mp.filter((p) => p.predicted !== null);
    const confusion = labels.map(() => labels.map(() => 0));
    ok.forEach((p) => {
      const i = labels.indexOf(p.gt), j = labels.indexOf(p.predicted!);
      if (i >= 0 && j >= 0) confusion[i][j]++;
    });
    const per_class = labels.map((label, i) => {
      const tp = confusion[i][i], support = confusion[i].reduce((a, b) => a + b, 0), pc = confusion.reduce((a, r) => a + r[i], 0);
      const precision = pc ? tp / pc : 0, recall = support ? tp / support : 0;
      return { label, support, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
    });
    const present = per_class.filter((c) => c.support > 0);
    const avg = (f: (c: (typeof per_class)[0]) => number) => present.reduce((a, c) => a + f(c), 0) / Math.max(1, present.length);
    const lat = mp.map((p) => p.latency).sort((a, b) => a - b);
    const q = (x: number) => (lat.length ? lat[Math.floor(x * (lat.length - 1))] : 0);
    const bins = Array.from({ length: 10 }, (_, b) => {
      const inb = ok.filter((p) => Math.min(9, Math.floor((p.top ?? 0) * 10)) === b);
      return { lower: b / 10, upper: (b + 1) / 10, count: inb.length, mean_confidence: inb.reduce((a, p) => a + (p.top ?? 0), 0) / Math.max(1, inb.length), accuracy: inb.filter((p) => p.predicted === p.gt).length / Math.max(1, inb.length) };
    });
    const ece = bins.reduce((a, b) => a + (b.count / Math.max(1, ok.length)) * Math.abs(b.accuracy - b.mean_confidence), 0);
    return {
      model: m, evaluated: mp.length, errors: mp.length - ok.length,
      accuracy: ok.filter((p) => p.predicted === p.gt).length / Math.max(1, ok.length),
      macro_precision: avg((c) => c.precision), macro_recall: avg((c) => c.recall), macro_f1: avg((c) => c.f1),
      weighted_f1: present.reduce((a, c) => a + c.f1 * c.support, 0) / Math.max(1, present.reduce((a, c) => a + c.support, 0)),
      mean_confidence: ok.reduce((a, p) => a + (p.confidence ?? 0), 0) / Math.max(1, ok.length),
      ece, latency_p50_ms: q(0.5), latency_p95_ms: q(0.95), latency_mean_ms: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
      per_class, confusion, calibration: bins,
      kappa: kappaFrom(ok.filter((p) => p.predicted === p.gt).length / Math.max(1, ok.length), labels.length),
    };
  });
  const agreement = e.config.models.map((a) => e.config.models.map((b) => {
    const pa = ps.filter((p) => p.model === a), pb = new Map(ps.filter((p) => p.model === b).map((p) => [p.row_idx, p.predicted]));
    const both = pa.filter((p) => pb.has(p.row_idx));
    return both.length ? both.filter((p) => pb.get(p.row_idx) === p.predicted).length / both.length : 0;
  }));
  const pairwise_kappa = agreement.map((row) => row.map((a) => kappaFrom(a, labels.length)));
  const offDiag = pairwise_kappa.flatMap((r, i) => r.filter((_, j) => j !== i));
  const fleiss_kappa = offDiag.length ? offDiag.reduce((a, b) => a + b, 0) / offDiag.length : null;
  const reviewed_rows = corrections.filter((c) => c.dataset === e.dataset_id && c.column === task.label_column).length;
  return { question_id: task.id, labels, models, agreement, pairwise_kappa, fleiss_kappa, reviewed_rows };
}

async function runExperiment(id: string) {
  const e = experiments.find((x) => x.id === id)!;
  e.status = "running";
  for (const m of e.config.models) {
    const key = m.replace(/:latest$/, "");
    if (!m.startsWith("@") && !mockLoaded.has(key)) {
      emit("experiment://progress", { experiment_id: id, model: m, done: e.progress[m] ?? 0, total: e.row_indices.length, status: "running", message: `Loading ${m}…`, loading: true });
      await sleep(3000);
      mockLoaded.add(key);
    }
    for (const i of e.row_indices) {
      if (e.status !== "running") return;
      await sleep(25);
      predictRow(id, e, m, i);
      e.progress[m] = (e.progress[m] ?? 0) + 1;
      emit("experiment://progress", { experiment_id: id, model: m, done: e.progress[m], total: e.row_indices.length, status: "running", message: null });
    }
  }
  e.status = "completed";
  e.finished_at = new Date().toISOString();
  emit("experiment://progress", { experiment_id: id, model: null, done: e.row_indices.length, total: e.row_indices.length, status: "completed", message: null });
}

function dist(keys: string[], boost: number) {
  const raw = keys.map(() => rand() ** 2);
  raw[0] += boost;
  const sum = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((k, i) => [k, raw[i] / sum])) as Record<string, number>;
}

/** Words (4+ letters) of a question's wording, for the mock's keyword evidence. */
const cue = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" ").toLowerCase().match(/[a-z]{4,}/g) ?? [];
const hits = (words: string[], text: string) => words.filter((w) => text.includes(w)).length;

// Answers depend only on the model, the questions and keywords in the text, so the same input
// gives the same answer and removing a telling word moves it (which "Why?" relies on).
function quick(model: string, questions: Record<string, AnyQuestion>, text = ""): Record<string, AnyAnswer> {
  const saved = seed;
  seed = [...(model + JSON.stringify(questions))].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2147483646, 7) + 1;
  const lower = text.toLowerCase();
  const out = quickRandom(model, questions);
  seed = saved;
  for (const [id, q] of Object.entries(questions)) {
    const a = out[id];
    if (a.type === "noul" && q.type === "noul") {
      const e = hits(cue(q.instructions, q.criteria?.true), lower) - hits(cue(q.criteria?.false), lower);
      const z = Math.log(a.noul / (1 - a.noul + 1e-9) + 1e-9) + 1.4 * e;
      a.noul = Math.round((1 / (1 + Math.exp(-z))) * 10000) / 10000;
    } else if ((a.type === "choice" || a.type === "rank" || a.type === "score") && (q.type === "choice" || q.type === "rank" || q.type === "score")) {
      const keys = Object.keys(a.probabilities);
      const desc = (k: string) => (q.type === "score" ? q.criteria[Number(k)] : (q.criteria as Record<string, string | null>)[k]);
      const raw = keys.map((k) => a.probabilities[k] * Math.exp(0.9 * hits(cue(k, desc(k)), lower)));
      const sum = raw.reduce((x, y) => x + y, 0);
      keys.forEach((k, i) => (a.probabilities[k] = raw[i] / sum));
      const top = keys.reduce((x, y) => (a.probabilities[x] > a.probabilities[y] ? x : y));
      const confidence = keys.length > 1 ? (keys.length * a.probabilities[top] - 1) / (keys.length - 1) : 1;
      if (a.type === "choice") Object.assign(a, { choice: top, confidence });
      else if (a.type === "rank") Object.assign(a, { ranking: [...keys].sort((x, y) => a.probabilities[y] - a.probabilities[x]), confidence });
      else Object.assign(a, { score: keys.reduce((x, k) => x + Number(k) * a.probabilities[k], 0), confidence });
    }
  }
  return out;
}

function quickRandom(model: string, questions: Record<string, AnyQuestion>): Record<string, AnyAnswer> {
  const out: Record<string, AnyAnswer> = {};
  const boost = model.includes("laya") ? 1.2 : 0.4;
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") out[id] = { type: "noul", noul: Math.round(rand() * 10000) / 10000 };
    else if (q.type === "text") out[id] = { type: "text", text: "A short written answer from the model." };
    else if (q.type === "multi") {
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.6 + rand() * 0.4 : rand()]));
      const t = q.threshold ?? 0.5;
      out[id] = { type: "multi", threshold: t, probabilities, selected: Object.keys(probabilities).filter((k) => probabilities[k] >= t) };
    } else if (q.type === "number") {
      const vals = [...q.values].sort((a, b) => a - b);
      const p = dist(vals.map(String), boost);
      const ps = vals.map((v) => p[String(v)]);
      const estimate = vals.reduce((a, v, i) => a + v * ps[i], 0);
      const cdf = (t: number) => { let acc = 0; for (let i = 0; i < vals.length; i++) { acc += ps[i]; if (acc >= t) return vals[i]; } return vals[vals.length - 1]; };
      const mi = ps.indexOf(Math.max(...ps));
      out[id] = { type: "number", estimate, most_likely: vals[mi], range: [cdf(0.1), cdf(0.9)], unit: q.unit ?? null, confidence: 0.3, probabilities: Object.fromEntries(vals.map((v, i) => [String(v), ps[i]])) };
    } else {
      const keys = q.type === "score" ? q.criteria.map((_, i) => String(i)) : Object.keys(q.criteria);
      const probabilities = dist(keys, boost);
      const top = keys.reduce((a, b) => (probabilities[a] > probabilities[b] ? a : b));
      const confidence = (keys.length * probabilities[top] - 1) / (keys.length - 1);
      if (q.type === "choice") out[id] = { type: "choice", choice: top, confidence, probabilities };
      else if (q.type === "rank") out[id] = { type: "rank", ranking: [...keys].sort((a, b) => probabilities[b] - probabilities[a]), confidence, probabilities };
      else out[id] = { type: "score", score: keys.reduce((a, k) => a + Number(k) * probabilities[k], 0), confidence, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), probabilities };
    }
  }
  return out;
}

const presetQuestions: Record<string, Record<string, AnyQuestion>> = {
  triage: {
    intent: { type: "choice", criteria: { refund: null, bug_report: null, question: null, complaint: null } },
    is_urgent: { type: "noul" },
    frustration: { type: "score", criteria: ["calm", "mildly annoyed", "frustrated", "very angry"] },
    churn_risk: { type: "noul" },
  },
};

const MOCK_UI = "classifai-mock-ui:";
/** Local models "in memory" (the mock's /api/ps). */
const mockLoaded = new Set<string>(["nli"]);
let hfToken: string | null = null;
let cliInstalled = false;

// ---- manual labelling (in memory) -------------------------------------------------------------
interface MockLabel { id: string; name: string; dataset_id: string; dataset_name: string; columns: string[]; question_set_id: string | null; question_set_version: number | null; questions: any; titles: Record<string, string>; row_order: number[]; position: number; saved_dataset_id: string | null; created_at: string; updated_at: string; answers: Record<number, Record<string, unknown>>; marks: Record<number, { skipped: boolean; flagged: boolean; note: string | null }>; evidence?: Record<number, Record<string, unknown[]>> }
const labelSessions: MockLabel[] = [];
const labelSummary = ({ answers, marks, evidence: _e, ...l }: MockLabel) => {
  const ids = Object.keys(l.titles);
  const counts = l.row_order.map((i) => ids.filter((q) => answers[i]?.[q] !== undefined).length);
  return { ...l, saved_dataset_name: datasets.find((d) => d.id === l.saved_dataset_id)?.name ?? null, total: l.row_order.length, done: counts.filter((c) => c >= ids.length).length, partial: counts.filter((c) => c > 0 && c < ids.length).length, skipped: Object.values(marks).filter((m) => m.skipped).length, flagged: Object.values(marks).filter((m) => m.flagged).length };
};

// ---- bulk runs (in memory) --------------------------------------------------------------------
interface MockBulkRow { pos: number; idx: number; input: string | null; answers?: unknown; error?: unknown; latency?: number | null; cost?: number | null }
interface MockBulk { id: string; name: string; model: string; source: string; dataset_id: string | null; dataset_name: string | null; columns: string[]; titles: Record<string, string>; setup: unknown; status: string; saved_dataset_id: string | null; created_at: string; finished_at: string | null; rows: MockBulkRow[] }
const bulkRuns: MockBulk[] = [];
const bulkSummary = ({ rows, ...b }: MockBulk) => ({
  ...b, saved_dataset_name: datasets.find((d) => d.id === b.saved_dataset_id)?.name ?? null,
  total: rows.length, answered: rows.filter((x) => x.answers).length, failed: rows.filter((x) => x.error).length, cost_usd: rows.reduce((a, x) => a + (x.cost ?? 0), 0),
});
function bulkRowView(b: MockBulk, row: MockBulkRow) {
  if (!b.dataset_id) return { ...row, input: row.input ?? "", fields: null };
  const data = rowsByDataset[b.dataset_id]?.[row.idx] ?? {};
  const fields = Object.fromEntries(b.columns.map((c) => [c, data[c] ?? ""]));
  return { ...row, input: b.columns.length === 1 ? fields[b.columns[0]] : b.columns.map((c) => `${c}: ${fields[c]}`).join("\n"), fields };
}

/** Mock of the store's derived datasets: rows are materialised here, the metadata matches. */
function derive(parentId: string, name: string, rows: [number, Row][], source: string | null): Dataset {
  const parent = datasets.find((d) => d.id === parentId)!;
  const base = rowsByDataset[parentId] ?? [];
  const added = [...new Set(rows.flatMap(([, c]) => Object.keys(c)))];
  const rename = Object.fromEntries(added.map((c) => { let n = c, k = 2; while (parent.columns.includes(n)) n = `${c} ${k++}`; return [c, n]; }));
  const d: Dataset = {
    id: `ds-${Date.now()}`, name, source, columns: [...parent.columns, ...added.map((c) => rename[c])], row_count: rows.length, created_at: new Date().toISOString(),
    parent_id: parent.parent_id ?? parent.id, parent_name: parent.parent_name ?? parent.name, added_columns: [...(parent.added_columns ?? []), ...added.map((c) => rename[c])],
  };
  datasets.unshift(d);
  rowsByDataset[d.id] = rows.map(([i, cells]) => ({ ...base[i], ...Object.fromEntries(Object.entries(cells).map(([k, v]) => [rename[k], v])) }));
  return d;
}

export async function invoke<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  await sleep(60);
  const r = (v: unknown) => v as T;
  switch (cmd) {
    case "app_info": return r({ version: "0.1.0", data_dir: "~/Library/Application Support/dev.classifai.app" });
    case "engine_status": return r({ ...engine });
    case "engine_start": await sleep(700); engine.running = true; return r({ ...engine });
    case "engine_stop": engine.running = false; return r({ ...engine });
    case "engine_install":
      for (const l of [">>> Installing Ollaya 0.9.2 (darwin-arm64)", ">>> Downloading ollaya-darwin-arm64.tgz", ">>> Verifying sha256", ">>> Installed Ollaya 0.9.2"]) {
        await sleep(400); emit("engine://install-log", l);
      }
      engine.installed = true; engine.running = true;
      return r({ ...engine });
    case "models_installed": return r(installed);
    case "models_catalog": return r(catalog);
    case "model_pull": {
      const total = 850_000_000;
      for (let c = 0; c <= total; c += total / 20) {
        await sleep(120);
        emit("model://pull", { model: args.model, status: "pulling 8d32a80bb199", completed: c, total, done: false, error: null });
      }
      installed.unshift({ name: args.model.includes(":") ? args.model : `${args.model}:latest`, modified_at: new Date().toISOString(), size: total, details: { format: "onnx", family: args.model.split(":")[0], parameter_size: "?", quantization_level: "F32" } });
      emit("model://pull", { model: args.model, status: "success", completed: total, total, done: true, error: null });
      return r(undefined);
    }
    case "model_delete": { const i = installed.findIndex((m) => m.name === args.model); if (i >= 0) installed.splice(i, 1); return r(undefined); }
    case "providers_list": return r(JSON.parse(JSON.stringify(providers)));
    case "provider_save": {
      const inp = args.input;
      let p = providers.find((x) => x.id === inp.id);
      if (!p) {
        p = { id: inp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), kind: inp.kind, name: inp.name, base_url: null, account_id: null, has_key: false, key_hint: null, builtin: false, models: [] };
        providers.push(p);
      }
      Object.assign(p, { name: inp.name, base_url: inp.base_url ?? p.base_url, account_id: inp.account_id ?? p.account_id });
      if (inp.api_key === "") Object.assign(p, { has_key: false, key_hint: null });
      else if (inp.api_key) Object.assign(p, { has_key: true, key_hint: `…${inp.api_key.slice(-4)}` });
      return r(p);
    }
    case "provider_delete": { const i = providers.findIndex((p) => p.id === args.id); if (i >= 0) providers.splice(i, 1); return r(undefined); }
    case "cli_status": return r({ state: cliInstalled ? "installed" : "not_installed", target: "/usr/local/bin/classifai", source: "/Applications/ClassifAI Studio.app/Contents/MacOS/classifai", points_to: cliInstalled ? "/Applications/ClassifAI Studio.app/Contents/MacOS/classifai" : null, on_path: true });
    case "cli_install": { await sleep(600); cliInstalled = true; return invoke("cli_status"); }
    case "cli_uninstall": { await sleep(300); cliInstalled = false; return invoke("cli_status"); }
    case "provider_models": {
      await sleep(400);
      const p = providers.find((x) => x.id === args.id);
      if (p?.kind === "cloudflare") throw { code: "INVALID", message: "Cloudflare doesn't list its decision models; enter the model name" };
      const m = (id: string, name: string, input: number | null, output: number | null, ctx: number | null, so: boolean | null, description: string | null = null) => ({ id, name, description, context_length: ctx, input_price_per_mtok: input, output_price_per_mtok: output, structured_output: so });
      if (p?.kind === "anthropic") return r([m("claude-haiku-4-5-20251001", "Claude Haiku 4.5", null, null, null, null), m("claude-sonnet-5-5", "Claude Sonnet 5.5", null, null, null, null), m("claude-opus-5-5", "Claude Opus 5.5", null, null, null, null)]);
      return r([
        m("openai/gpt-5-mini", "OpenAI: GPT-5 Mini", 0.25, 2, 400000, true, "Small, fast GPT-5 for well-defined tasks."),
        m("anthropic/claude-haiku-4.5", "Anthropic: Claude Haiku 4.5", 1, 5, 200000, true, "Anthropic's fastest model."),
        m("google/gemini-2.5-flash", "Google: Gemini 2.5 Flash", 0.3, 2.5, 1048576, true, "Workhorse model with thinking."),
        m("meta-llama/llama-3.1-8b-instruct", "Meta: Llama 3.1 8B Instruct", 0.02, 0.03, 131072, false, "Small open model."),
        m("mistralai/mistral-small-3.2", "Mistral: Mistral Small 3.2", 0.05, 0.1, 128000, true),
        m("qwen/qwen3-30b-a3b", "Qwen: Qwen3 30B A3B", 0.08, 0.29, 40960, true),
      ]);
    }
    case "provider_test": {
      await sleep(600);
      const p = providers.find((x) => x.id === args.id)!;
      return r(p.has_key || p.kind === "custom" ? { ok: true, message: "Connected · answered in 212 ms", latency_ms: 212 } : { ok: false, message: "No API key set", latency_ms: 0 });
    }
    case "cloud_model_save": {
      const inp = args.input; const p = providers.find((x) => x.id === inp.provider_id)!;
      let m = p.models.find((x) => x.model === inp.model);
      if (!m) { m = { ...cm(p.id, inp.model, inp.display_name || inp.model, "", inp.input_price_per_mtok), builtin: false }; p.models.push(m); }
      Object.assign(m, { input_price_per_mtok: inp.input_price_per_mtok, output_price_per_mtok: inp.output_price_per_mtok, enabled: inp.enabled, display_name: inp.display_name || m.display_name });
      return r(m);
    }
    case "cloud_model_delete": { providers.forEach((p) => (p.models = p.models.filter((m) => m.id !== args.id))); return r(undefined); }
    case "usage_summary": case "experiment_usage": {
      const rows = new Map<string, UsageRow>();
      usageLog.filter((u) => cmd === "usage_summary" || u.exp === args.id).forEach((u) => {
        const row = rows.get(u.model) ?? { model: u.model, requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        row.requests += 1; row.input_tokens += u.tokens; row.cost_usd += u.cost; rows.set(u.model, row);
      });
      return r([...rows.values()].sort((a, b) => b.cost_usd - a.cost_usd));
    }
    case "dataset_import_text": {
      const d: Dataset = { id: `ds-${datasets.length + 1}`, name: args.name || "pasted", source: null, columns: datasets[0].columns, row_count: demoRows.length, created_at: new Date().toISOString() };
      datasets.unshift(d); rowsByDataset[d.id] = demoRows; return r(d);
    }
    case "experiment_estimate": {
      const c = args.config as ExperimentConfig;
      const rows = Math.min(c.sample_size ?? 160, 160);
      const per_model = c.models.map((m) => {
        const cloud = cloudFor(m);
        const tok = rows * (60 + c.tasks.length * 25);
        return { model: m, est_input_tokens: tok, est_cost_usd: cloud ? (tok * cloud.input_price_per_mtok) / 1e6 : 0, est_seconds: (rows * (speed[m] ?? 300)) / 1000 / (c.concurrency ?? 4) };
      });
      return r({ rows, requests: rows * c.models.length, per_model, total_cost_usd: per_model.reduce((a, x) => a + x.est_cost_usd, 0), total_seconds: per_model.reduce((a, x) => a + x.est_seconds, 0) });
    }
    case "experiment_threshold_curve": {
      const points = Array.from({ length: 19 }, (_, i) => {
        const t = (i + 1) / 20;
        const recall = Math.min(1, 1.05 - t * 0.8), precision = Math.min(1, 0.45 + t * 0.6);
        return { threshold: t, precision, recall, f1: (2 * precision * recall) / (precision + recall), accuracy: 0.6 + 0.3 * Math.sin(t * Math.PI) };
      });
      const e = experiments.find((x) => x.id === args.id)!;
      return r({ points, current: e.config.tasks.find((t) => t.id === args.question)?.threshold ?? 0.5 });
    }
    case "experiment_set_threshold": {
      const e = experiments.find((x) => x.id === args.id)!;
      const t = e.config.tasks.find((x) => x.id === args.question); if (t) t.threshold = args.threshold;
      return r(undefined);
    }
    case "experiment_review_queue": return invoke<T>("experiment_predictions", { id: args.id, question: args.question, filter: args.strategy === "disagree" ? "disagree" : "wrong", offset: args.offset, limit: args.limit });
    case "experiment_export_report": return r(args.path);
    case "label_corrections_list": return r(corrections.filter((c) => c.dataset === args.datasetId));
    case "label_correction_set": {
      const rows = rowsByDataset[args.datasetId];
      const i = corrections.findIndex((c) => c.dataset === args.datasetId && c.row_idx === args.rowIdx && c.column === args.column);
      const entry = { dataset: args.datasetId, row_idx: args.rowIdx, column: args.column, original: rows[args.rowIdx][args.column], value: args.value, note: args.note ?? null, at: new Date().toISOString() };
      if (i >= 0) corrections[i] = entry; else corrections.push(entry);
      return r(undefined);
    }
    case "label_correction_clear": { const i = corrections.findIndex((c) => c.dataset === args.datasetId && c.row_idx === args.rowIdx && c.column === args.column); if (i >= 0) corrections.splice(i, 1); return r(undefined); }
    case "question_sets_list": return r(questionSets.map(({ payload, ...q }) => ({ ...q, question_count: payload.questions.length })));
    case "question_set_get": return r(questionSets.find((q) => q.id === args.id));
    case "question_set_save": {
      const inp = args.input;
      let q = questionSets.find((x) => x.id === inp.id);
      if (!q) { q = { id: inp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: inp.name, description: inp.description ?? "", version: 0, payload: inp.payload, updated_at: "" }; questionSets.unshift(q); }
      Object.assign(q, { name: inp.name, description: inp.description ?? q.description, payload: inp.payload, version: inp.amend && q.version > 0 ? q.version : q.version + 1, updated_at: new Date().toISOString() });
      return r({ ...q, question_count: q.payload.questions.length });
    }
    case "question_set_delete": { const i = questionSets.findIndex((q) => q.id === args.id); if (i >= 0) questionSets.splice(i, 1); return r(undefined); }
    case "settings_get": return r({ ...settings });
    case "settings_save": settings = { ...args.input }; return r({ ...settings });
    case "budget_status": {
      const spend = usageLog.reduce((a, u) => a + u.cost, 0);
      const b = settings.monthly_budget_usd;
      return r({ month_spend_usd: spend, budget_usd: b, ratio: b ? spend / b : null, exceeded: !!b && spend >= b });
    }
    case "models_track_record": return r([
      { model: "laya", experiment_id: "exp-1", experiment_name: "Routing baseline", question_id: "department", macro_f1: 0.91, accuracy: 0.92 },
      { model: "@typesafe/jev-latest", experiment_id: "exp-1", experiment_name: "Routing baseline", question_id: "department", macro_f1: 0.94, accuracy: 0.94 },
    ]);
    case "preset_show": return r(presetQuestions[args.name] ?? presetQuestions.triage);
    case "save_text_file": return r(undefined);
    case "read_text_file": return r(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Abstract screening", description: "Abstracts of studies on remote work and wellbeing.", type: "object", properties: { design: { type: "string", enum: ["RCT", "cohort", "cross-sectional", "qualitative"], description: "What is the study design?" }, include: { type: "boolean", description: "The study meets the inclusion criteria." }, quality: { type: "integer", minimum: 1, maximum: 5, title: "Reporting quality" }, outcomes: { type: "array", items: { enum: ["stress", "productivity", "sleep"] }, description: "Which outcomes are measured?" }, sample: { type: "integer", minimum: 0, maximum: 5000, description: "How many participants?" }, finding: { type: "string", description: "Main finding in one sentence" } } }, null, 2));
    case "presets_list": return r([{ name: "triage", builtin: true, description: "Support tickets: intent, urgency, frustration, refund request, churn risk", questions: ["intent", "is_urgent", "frustration", "churn_risk"] }, { name: "moderation", builtin: true, description: "Content moderation", questions: ["toxic", "category"] }]);
    case "models_loaded": return r([...mockLoaded]);
    case "quick_classify": {
      // A cold local model is loaded first (a few seconds), as the real engine does.
      const cold = !args.req.model.startsWith("@") && !mockLoaded.has(args.req.model.replace(/:latest$/, ""));
      if (cold) { await sleep(3500); mockLoaded.add(args.req.model.replace(/:latest$/, "")); }
      const q = args.req.questions ?? presetQuestions[args.req.preset] ?? presetQuestions.triage;
      const ms = (speed[args.req.model.replace(":latest", "")] ?? 200) * (0.7 + rand() * 0.6);
      await sleep(Math.min(ms, 900));
      const cloud = cloudFor(args.req.model);
      const tokens = 40 + Object.keys(q).length * 30;
      const cost = cloud ? (tokens * cloud.input_price_per_mtok) / 1e6 : 0;
      usageLog.push({ model: args.req.model, tokens, cost });
      return r({ model: args.req.model, answered_by: args.req.model === "laya:latest" ? "laya:en" : args.req.model, answers: quick(args.req.model, q, args.req.state ?? ""), routing: args.req.model === "laya:latest" ? { router: "laya:latest", model: "laya:en", route: "english", reason: "English Latin text" } : null, latency_ms: ms, load_ms: 0, state_truncated: false, usage: { input_tokens: tokens, output_tokens: 0 }, cost_usd: cost, refused: [], quotes: llmQuotes(args.req.model, q, args.req.state ?? "") });
    }
    case "dataset_import": {
      const d: Dataset = { id: `ds-${datasets.length + 1}`, name: args.name ?? "support_tickets_copy", source: args.path, columns: datasets[0].columns, row_count: demoRows.length, created_at: new Date().toISOString() };
      datasets.unshift(d); rowsByDataset[d.id] = demoRows; return r(d);
    }
    case "ui_state_get": {
      const out: Record<string, unknown> = {};
      try { for (const k of Object.keys(localStorage)) if (k.startsWith(MOCK_UI)) out[k.slice(MOCK_UI.length)] = JSON.parse(localStorage.getItem(k)!); } catch { /* none */ }
      return r(out);
    }
    case "ui_state_set": {
      try { if (args.value === null || args.value === undefined) localStorage.removeItem(MOCK_UI + args.key); else localStorage.setItem(MOCK_UI + args.key, JSON.stringify(args.value)); } catch { /* none */ }
      return r(undefined);
    }
    case "dataset_create": {
      const d: Dataset = { id: `ds-${Date.now()}`, name: args.name, source: null, columns: args.columns, row_count: args.rows.length, created_at: new Date().toISOString(), parent_id: null, parent_name: null, added_columns: [] };
      datasets.unshift(d); rowsByDataset[d.id] = args.rows; return r(d);
    }
    case "dataset_derive": return r(derive(args.parentId, args.name, args.rows, args.source ?? null));
    case "experiment_save_as_dataset": {
      const e = experiments.find((x) => x.id === args.id)!;
      const many = e.config.models.length > 1;
      const rows = e.row_indices.map((idx) => {
        const cells: Row = {};
        for (const p of (preds[e.id] ?? []).filter((p) => p.row_idx === idx)) {
          const col = many ? `${p.q} · ${p.model.replace(/:latest$/, "").replace(/^@[^/]+\//, "")}` : p.q;
          cells[col] = p.predicted ?? "";
          cells[`${col} confidence`] = p.confidence?.toFixed(3) ?? "";
        }
        return [idx, cells] as [number, Row];
      });
      return r(derive(e.dataset_id, args.name || `${e.name} results`, rows, `Evaluation: ${e.name}`));
    }
    case "bulk_runs_list": return r(bulkRuns.map(bulkSummary));
    case "bulk_run_get": { const b = bulkRuns.find((x) => x.id === args.id)!; return r({ ...bulkSummary(b), rows: b.rows.map((row) => bulkRowView(b, row)) }); }
    case "bulk_run_create": {
      const i = args.input; const ds = datasets.find((d) => d.id === i.dataset_id);
      const b: MockBulk = { id: `bulk-${Date.now()}`, name: i.name, model: i.model, source: i.source, dataset_id: ds?.id ?? null, dataset_name: ds?.name ?? null, columns: i.columns, titles: i.titles, setup: i.setup, status: "running", saved_dataset_id: null, created_at: new Date().toISOString(), finished_at: null,
        rows: i.entries.map((e: { row_idx: number; input?: string }, pos: number) => ({ pos, idx: e.row_idx, input: ds ? null : e.input ?? "" })) };
      bulkRuns.unshift(b); return r(bulkSummary(b));
    }
    case "bulk_results_put": { const b = bulkRuns.find((x) => x.id === args.id); for (const res of args.results) Object.assign(b!.rows[res.pos], { answers: res.answers ?? null, error: res.error ?? null, latency: res.latency_ms ?? null, cost: res.cost_usd ?? null }); return r(undefined); }
    case "bulk_run_finish": { const b = bulkRuns.find((x) => x.id === args.id); if (b) { b.status = args.status; b.finished_at = new Date().toISOString(); } return r(undefined); }
    case "bulk_run_rename": { const b = bulkRuns.find((x) => x.id === args.id); if (b) b.name = args.name; return r(undefined); }
    case "bulk_run_set_saved": { const b = bulkRuns.find((x) => x.id === args.id); if (b) b.saved_dataset_id = args.datasetId; return r(undefined); }
    case "bulk_run_delete": { const i = bulkRuns.findIndex((x) => x.id === args.id); if (i >= 0) bulkRuns.splice(i, 1); return r(undefined); }
    case "hf_info": {
      await sleep(500);
      const name = String(args.dataset).replace(/^.*huggingface\.co\/datasets\//, "").split("/").slice(0, 2).join("/");
      if (!name.includes("/") && name !== "imdb") throw { code: "INVALID", message: "Hugging Face did not find this dataset. If it is private or gated, add your Hugging Face token" };
      return r({ dataset: name, can_filter: true, can_search: true, configs: [{ config: "plain_text", features: [{ name: "text", kind: "string", labels: null }, { name: "label", kind: "ClassLabel", labels: ["neg", "pos"] }], splits: [{ split: "train", num_rows: 25000 }, { split: "test", num_rows: 25000 }, { split: "unsupervised", num_rows: 50000 }] }] });
    }
    case "hf_import": {
      const spec = args.spec; const out: Dataset[] = [];
      const short = spec.dataset.split("/").pop();
      const want = (sel: any, total: number) => (sel.kind === "full" ? total : Math.min(sel.n, total));
      const tables = spec.parts.map((p: any, i: number) => {
        const n = Math.min(want(p.selection, 25000), 400);
        const rows: Row[] = Array.from({ length: n }, (_, k) => ({ text: `${phrases[departments[k % 4]][k % 5]} (${p.split} #${k})`, label: k % 3 ? "pos" : "neg" }));
        emit("hf://progress", { part: i, parts: spec.parts.length, label: p.split, done: n, total: n });
        return { split: p.split, rows };
      });
      await sleep(900);
      const cols = spec.columns?.length ? spec.columns : ["text", "label"];
      const make = (name: string, rows: Row[], columns: string[]) => { const d: Dataset = { id: `ds-${Date.now()}-${out.length}`, name, source: `hf://datasets/${spec.dataset}`, columns, row_count: rows.length, created_at: new Date().toISOString(), parent_id: null, parent_name: null, added_columns: [] }; datasets.unshift(d); rowsByDataset[d.id] = rows; out.push(d); };
      if (spec.combine && tables.length > 1) make(spec.name || short, tables.flatMap((t: any) => t.rows.map((row: Row) => ({ ...row, split: t.split }))), [...cols, "split"]);
      else tables.forEach((t: any) => make(tables.length === 1 && spec.name ? spec.name : `${spec.name || short} · ${t.split}`, t.rows, cols));
      return r(out);
    }
    case "hf_cancel": return r(undefined);
    case "hf_token_status": return r(hfToken ? `…${hfToken.slice(-4)}` : null);
    case "hf_token_set": hfToken = args.token.trim() || null; return r(undefined);
    case "dataset_rows_at": { const rows = rowsByDataset[args.id] ?? []; return r(args.indices.filter((i: number) => rows[i]).map((i: number) => [i, rows[i]])); }
    case "label_sessions_list": return r(labelSessions.map(labelSummary));
    case "label_session_get": { const l = labelSessions.find((x) => x.id === args.id); if (!l) throw { code: "NOT_FOUND", message: `labelling session ${args.id} not found` }; return r({ ...labelSummary(l), answers: l.answers, marks: l.marks, evidence: l.evidence ?? {} }); }
    case "label_session_create": {
      const i = args.input; const d = datasets.find((x) => x.id === i.dataset_id)!;
      const n = Math.min(i.limit ?? d.row_count, d.row_count);
      let order = Array.from({ length: d.row_count }, (_, k) => k);
      if (i.order === "random") order = order.map((v) => [rand(), v] as const).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      const l: MockLabel = { id: `lab-${Date.now()}`, name: i.name, dataset_id: d.id, dataset_name: d.name, columns: i.columns, question_set_id: i.question_set_id ?? null, question_set_version: i.question_set_version ?? null, questions: i.questions, titles: i.titles, row_order: order.slice(0, n), position: 0, saved_dataset_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), answers: {}, marks: {} };
      labelSessions.unshift(l); return r(labelSummary(l));
    }
    case "label_answer_set": { const l = labelSessions.find((x) => x.id === args.id)!; const a = (l.answers[args.rowIdx] ??= {}); if (args.value === null || args.value === undefined) delete a[args.questionId]; else a[args.questionId] = args.value; l.updated_at = new Date().toISOString(); return r(undefined); }
    case "label_evidence_set": { const l = labelSessions.find((x) => x.id === args.id)!; const e = ((l.evidence ??= {})[args.rowIdx] ??= {}); if (args.snippets.length) e[args.questionId] = args.snippets; else delete e[args.questionId]; return r(undefined); }
    case "label_mark_set": { const l = labelSessions.find((x) => x.id === args.id)!; if (!args.mark.skipped && !args.mark.flagged && !args.mark.note) delete l.marks[args.rowIdx]; else l.marks[args.rowIdx] = args.mark; return r(undefined); }
    case "label_position_set": { const l = labelSessions.find((x) => x.id === args.id); if (l) l.position = args.position; return r(undefined); }
    case "label_session_update": { const l = labelSessions.find((x) => x.id === args.id)!; if (args.name) l.name = args.name; if (args.columns) l.columns = args.columns; if (args.questions) { l.questions = args.questions; l.titles = args.titles; } return r(undefined); }
    case "label_session_set_saved": { const l = labelSessions.find((x) => x.id === args.id); if (l) l.saved_dataset_id = args.datasetId; return r(undefined); }
    case "label_session_delete": { const i = labelSessions.findIndex((x) => x.id === args.id); if (i >= 0) labelSessions.splice(i, 1); return r(undefined); }
    case "spreadsheet_inspect": {
      await sleep(300);
      const grid = [["Exported from CRM", "", "", "", ""], ["", "", "", "", ""], ["id", "message", "team", "amount", "date"], ...demoRows.slice(0, 17).map((d, i) => [String(i + 1), d.body, d.department.trim().replace(/\.$/, ""), (i * 7.5).toFixed(2), `2026-10-${String((i % 28) + 1).padStart(2, "0")}`])];
      return r([{ name: "Tickets", rows: 162, width: 5, header_guess: 0, preview: grid }, { name: "Summary", rows: 3, width: 2, header_guess: 0, preview: [["metric", "value"], ["tickets", "160"], ["open", "12"]] }]);
    }
    case "spreadsheet_import": {
      const all = ["id", "message", "team", "amount", "date"];
      const cols = (args.columns.length ? args.columns : [0, 1, 2, 3, 4]).map((c: number) => all[c]);
      const rows = demoRows.map((d, i) => Object.fromEntries(cols.map((c: string) => [c, c === "id" ? String(i + 1) : c === "message" ? d.body : c === "team" ? d.department : c === "amount" ? (i * 7.5).toFixed(2) : `2026-10-${String((i % 28) + 1).padStart(2, "0")}`])) as Row);
      const d: Dataset = { id: `ds-${Date.now()}`, name: args.name || `tickets · ${args.sheet}`, source: `${args.path}#${args.sheet}`, columns: cols, row_count: rows.length, created_at: new Date().toISOString(), parent_id: null, parent_name: null, added_columns: [] };
      datasets.unshift(d); rowsByDataset[d.id] = rows; return r(d);
    }
    case "files_import": {
      await sleep(600);
      const img = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#e8eefc"/><rect x="40" y="40" width="400" height="220" rx="12" fill="#fff" stroke="#9db4f0"/><text x="70" y="100" font-family="Helvetica" font-size="28" fill="#1d3b8a">RECEIPT</text><text x="70" y="150" font-family="Helvetica" font-size="18" fill="#555">Coffee x2 ........ 7.40</text><text x="70" y="180" font-family="Helvetica" font-size="18" fill="#555">Croissant ........ 3.20</text><text x="70" y="225" font-family="Helvetica" font-size="20" fill="#111">TOTAL 10.60 EUR</text></svg>');
      const content: Record<string, string> = { docx: "# Quarterly report\n\nRevenue grew **12%** and costs were *flat*.\n\n- North\n- South", pdf: "Abstract\n\nWe study hyphenated words across lines in PDFs.", md: "# Notes\n\nCall the customer back on Monday." };
      const rows: Row[] = args.paths.map((p: string, i: number) => {
        const ext = p.split(".").pop()!.toLowerCase(); const name = p.split("/").pop()!;
        const image = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);
        return { name, kind: image ? "image" : ext === "md" || ext === "txt" ? "text" : ext, content: image ? "" : content[ext] ?? "", file: image ? img : "", source_path: p, _i: String(i) };
      }).map(({ _i, ...row }: Row) => row);
      const d: Dataset = { id: `ds-${Date.now()}`, name: args.name || `Files (${rows.length})`, source: `${rows.length} files`, columns: ["name", "kind", "content", "file", "source_path"], row_count: rows.length, created_at: new Date().toISOString(), parent_id: null, parent_name: null, added_columns: [] };
      datasets.unshift(d); rowsByDataset[d.id] = rows; return r({ dataset: d, skipped: [] });
    }
    case "dataset_list": return r(datasets);
    case "dataset_get": return r(datasets.find((d) => d.id === args.id));
    case "dataset_rows": {
      let rows = (rowsByDataset[args.id] ?? []).map((row, i) => [i, row] as [number, Row]);
      if (args.search) { const q = String(args.search).toLowerCase(); rows = rows.filter(([, row]) => Object.values(row).some((v) => v.toLowerCase().includes(q))); }
      if (args.sortColumn) rows = [...rows].sort((a, b) => (a[1][args.sortColumn] ?? "").localeCompare(b[1][args.sortColumn] ?? "", undefined, { numeric: true }) * (args.sortDesc ? -1 : 1));
      return r({ rows: rows.slice(args.offset, args.offset + args.limit), total: rows.length });
    }
    case "dataset_column_profile": {
      const counts = new Map<string, number>(); let empty = 0; const rows = rowsByDataset[args.id] ?? [];
      rows.forEach((row) => { const v = (row[args.column] ?? "").trim(); if (!v) empty++; else counts.set(v, (counts.get(v) ?? 0) + 1); });
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      return r({ rows: rows.length, empty, distinct: sorted.length, top: sorted.slice(0, args.limit ?? 300).map(([value, count]) => ({ value, count })) });
    }
    case "dataset_value_counts": {
      const counts = new Map<string, number>();
      (rowsByDataset[args.id] ?? []).forEach((row) => { const v = (row[args.column] ?? "").trim(); counts.set(v, (counts.get(v) ?? 0) + 1); });
      return r([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([value, count]) => ({ value, count })));
    }
    case "dataset_rename": { const d = datasets.find((x) => x.id === args.id); if (d) d.name = args.name; return r(undefined); }
    case "dataset_delete": { const i = datasets.findIndex((d) => d.id === args.id); if (i >= 0) datasets.splice(i, 1); return r(undefined); }
    case "experiment_create": {
      const c = args.config as ExperimentConfig;
      const rows = rowsByDataset[c.dataset_id];
      let idx = rows.map((row, i) => [row, i] as const).filter(([row]) => c.tasks.some((t) => gtOf(row, t) !== null)).map(([, i]) => i);
      if (c.sample_size && c.sample_size < idx.length) idx = idx.slice(0, c.sample_size);
      const id = `exp-${experiments.length + 1}`;
      preds[id] = [];
      experiments.unshift({ id, name: c.name, dataset_id: c.dataset_id, dataset_name: datasets.find((d) => d.id === c.dataset_id)?.name ?? "", config: c, status: "pending", error: null, row_indices: idx, progress: Object.fromEntries(c.models.map((m) => [m, 0])), created_at: new Date().toISOString(), finished_at: null });
      return r(id);
    }
    case "experiment_start": void runExperiment(args.id); return r(undefined);
    case "experiment_cancel": { const e = experiments.find((x) => x.id === args.id); if (e && e.status === "running") { e.status = "cancelled"; emit("experiment://progress", { experiment_id: e.id, model: null, done: 0, total: e.row_indices.length, status: "cancelled", message: null }); } return r(undefined); }
    case "experiment_list": return r(experiments.filter((e) => !args.datasetId || e.dataset_id === args.datasetId));
    case "experiment_get": return r(experiments.find((e) => e.id === args.id));
    case "experiment_report": return r(report(experiments.find((e) => e.id === args.id)!, args.question));
    case "experiment_predictions": {
      const e = experiments.find((x) => x.id === args.id)!;
      const task = e.config.tasks.find((t) => t.id === args.question) ?? e.config.tasks[0];
      const rows = rowsByDataset[e.dataset_id];
      const all: PredictionRow[] = e.row_indices
        .filter((i) => gtOf(rows[i], task) !== null)
        .map((i) => {
          const by_model = Object.fromEntries(e.config.models.map((m) => {
            const p = preds[e.id].find((p) => p.model === m && p.row_idx === i && p.q === task.id);
            return [m, p ? { predicted: p.predicted, confidence: p.confidence, error: p.error } : { predicted: null, confidence: null, error: "pending" }];
          }));
          const cols = e.config.input_columns;
          const st = cols.length === 1 ? rows[i][cols[0]] : JSON.stringify(Object.fromEntries(cols.map((c) => [c, rows[i][c]])));
          const corr = corrections.find((c) => c.dataset === e.dataset_id && c.row_idx === i && c.column === task.label_column);
          return { row_idx: i, input: st, ground_truth: corr?.value ?? gtOf(rows[i], task)!, by_model, corrected: !!corr, original_ground_truth: corr?.original ?? null, review_note: corr?.note ?? null };
        });
      const f: string = args.filter;
      const filtered = all.filter((row) => {
        const cells = Object.entries(row.by_model);
        if (f === "wrong") return cells.some(([, c]) => c.predicted !== row.ground_truth);
        if (f === "disagree") return new Set(cells.map(([, c]) => c.predicted)).size > 1;
        if (f.startsWith("wrong:")) return row.by_model[f.slice(6)]?.predicted !== row.ground_truth;
        return true;
      });
      return r({ rows: filtered.slice(args.offset, args.offset + args.limit), total: filtered.length });
    }
    case "experiment_delete": { const i = experiments.findIndex((e) => e.id === args.id); if (i >= 0) experiments.splice(i, 1); return r(undefined); }
    case "experiment_export_csv": return r(experiments.find((e) => e.id === args.id)?.row_indices.length ?? 0);
  }
  throw { code: "MOCK", message: `mock: unknown command ${cmd}` };
}
