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
  id: `@${provider_id}/${model}`, provider_id, model, display_name, description, input_price_per_mtok: input, output_price_per_mtok: 0, enabled, builtin: true,
});
const providers: Provider[] = [
  { id: "typesafe", kind: "typesafe", name: "TypeSafe Jev", base_url: null, account_id: null, has_key: true, key_hint: "…a91f", builtin: true,
    models: [cm("typesafe", "jev-latest", "Jev", "TypeSafe's hosted System One model — the reference decision model.", 0.042)] },
  { id: "openai", kind: "openai", name: "OpenAI Decisions", base_url: null, account_id: null, has_key: false, key_hint: null, builtin: true,
    models: [cm("openai", "gpt-6-luna", "GPT-6 Luna", "OpenAI's Decisions API (beta). Predicates, choices and scores with probabilities.", 0.1)] },
  { id: "cloudflare", kind: "cloudflare", name: "Cloudflare Workers AI", base_url: null, account_id: null, has_key: false, key_hint: null, builtin: true,
    models: [cm("cloudflare", "clef-flash", "Clef Flash", "Cloudflare's 9B Clef with a joint schema head. 65k context.", 0.09), cm("cloudflare", "clef", "Clef", "The 27B Clef. Higher accuracy, 65k context, reads images.", 0.24, false)] },
];
const usageLog: { model: string; tokens: number; cost: number; exp?: string }[] = [
  { model: "@typesafe/jev-latest", tokens: 182_400, cost: 0.0077 },
  { model: "laya:latest", tokens: 96_000, cost: 0 },
];
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
  return { id: String(1000 + i), subject: p.split(" ").slice(0, 4).join(" ") + "…", body: p + "." + t, department: d, priority: rand() > 0.7 ? "high" : "normal" };
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
  return t.labels.some((l) => l.value === v) ? v : null;
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
usageLog.push({ model: "@typesafe/jev-latest", tokens: 120 * 140, cost: (120 * 140 * 0.042) / 1e6, exp: "exp-1" }, { model: "laya", tokens: 120 * 140, cost: 0, exp: "exp-1" });

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
    };
  });
  const agreement = e.config.models.map((a) => e.config.models.map((b) => {
    const pa = ps.filter((p) => p.model === a), pb = new Map(ps.filter((p) => p.model === b).map((p) => [p.row_idx, p.predicted]));
    const both = pa.filter((p) => pb.has(p.row_idx));
    return both.length ? both.filter((p) => pb.get(p.row_idx) === p.predicted).length / both.length : 0;
  }));
  return { question_id: task.id, labels, models, agreement };
}

async function runExperiment(id: string) {
  const e = experiments.find((x) => x.id === id)!;
  e.status = "running";
  for (const m of e.config.models) {
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

function quick(model: string, questions: Record<string, AnyQuestion>): Record<string, AnyAnswer> {
  const out: Record<string, AnyAnswer> = {};
  const boost = model.includes("laya") ? 1.2 : 0.4;
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") out[id] = { type: "noul", noul: Math.round(rand() * 10000) / 10000 };
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
    case "presets_list": return r([{ name: "triage", builtin: true, description: "Support tickets: intent, urgency, frustration, refund request, churn risk", questions: ["intent", "is_urgent", "frustration", "churn_risk"] }, { name: "moderation", builtin: true, description: "Content moderation", questions: ["toxic", "category"] }]);
    case "quick_classify": {
      const q = args.req.questions ?? presetQuestions[args.req.preset] ?? presetQuestions.triage;
      const ms = (speed[args.req.model.replace(":latest", "")] ?? 200) * (0.7 + rand() * 0.6);
      await sleep(Math.min(ms, 900));
      const cloud = cloudFor(args.req.model);
      const tokens = 40 + Object.keys(q).length * 30;
      const cost = cloud ? (tokens * cloud.input_price_per_mtok) / 1e6 : 0;
      usageLog.push({ model: args.req.model, tokens, cost });
      return r({ model: args.req.model, answered_by: args.req.model === "laya:latest" ? "laya:en" : args.req.model, answers: quick(args.req.model, q), routing: args.req.model === "laya:latest" ? { router: "laya:latest", model: "laya:en", route: "english", reason: "English Latin text" } : null, latency_ms: ms, load_ms: 0, state_truncated: false, usage: { input_tokens: tokens, output_tokens: 0 }, cost_usd: cost, refused: [] });
    }
    case "dataset_import": {
      const d: Dataset = { id: `ds-${datasets.length + 1}`, name: args.name ?? "support_tickets_copy", source: args.path, columns: datasets[0].columns, row_count: demoRows.length, created_at: new Date().toISOString() };
      datasets.unshift(d); rowsByDataset[d.id] = demoRows; return r(d);
    }
    case "dataset_list": return r(datasets);
    case "dataset_get": return r(datasets.find((d) => d.id === args.id));
    case "dataset_rows": { const rows = rowsByDataset[args.id] ?? []; return r({ rows: rows.slice(args.offset, args.offset + args.limit).map((row, i) => [args.offset + i, row]), total: rows.length }); }
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
          return { row_idx: i, input: st, ground_truth: gtOf(rows[i], task)!, by_model };
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
