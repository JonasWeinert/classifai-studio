# ClassifAI: product plan

## One-liner

A local-first desktop app (and later a CLI) for classifying data with open **decision models**,
measuring them against your own ground truth, and choosing (and eventually fine-tuning) the right one.

## Problem

Teams that need to route tickets, tag feedback, moderate content or triage email face the same
questions every time:

- *Which model is good enough for my labels?* Public leaderboards measure someone else's task.
- *Is it fast enough on my hardware?* Numbers measured on an RTX 4090 say little about a laptop CPU.
- *Can I trust its confidence?* A 0.9 that is right only 60% of the time makes automation unsafe.
- *How do I try it on one example right now?* Without writing a script.

LLM playgrounds answer none of these well. They generate text, cost money per call, send data off
the machine and are not calibrated. Decision models (Laya, NLI, GLiClass, Winnow, Clef, …) are
small, local, calibrated and fast, but today the only way to compare them is to write evaluation
code.

## Who it's for

| Persona | Job to be done |
|---|---|
| **ML / data engineer** | "Before I wire a classifier into the pipeline, show me which model wins on *our* labelled data, with what latency and calibration." |
| **Product / ops analyst** | "I have a spreadsheet of tagged tickets. Tell me if a model can do this tagging, without writing Python." |
| **Developer prototyping** | "Paste a message, see what each model says, iterate on label wording." |

## Principles

1. **Local-first.** Data never leaves the machine; models run through Ollaya on localhost.
2. **Ground truth is the product.** Every number is measured against the user's labels.
3. **Compare, don't just run.** Every result is shown side by side across models.
4. **Honest metrics.** Macro F1 over accuracy, calibration (ECE) next to accuracy, p50 and p95 latency.
5. **One core, many surfaces.** Desktop, CLI and later CI all use `classifai-core`.

## Roadmap

### Phase 0: MVP (this scaffold) ✅

- First-launch onboarding: install Ollaya into the app folder, start the daemon, pull a starter model.
- Playground: one input, a question (labels, yes/no, scale or Ollaya preset), N models, results side by side.
- Datasets: import CSV/TSV/JSON/JSONL, browse rows, profile columns.
- Experiments: choose input columns, ground-truth column, labels (with optional descriptions), models
  and sample size; run with live progress, cancel and resume.
- Results: leaderboard (accuracy, macro/weighted F1, precision, recall, ECE, p50/p95), confusion
  matrix, per-label F1, reliability diagram, model agreement, error explorer, CSV export.
- Model library: curated catalog, pull with progress, remove, pull any name.
- Fine-tune screen as a **mockup**.
- CLI preview (`classifai status|models|pull|check|datasets|experiments|report|run`).

### Phase 1: make evaluation decision-grade (next 4–6 weeks)

- **Prompt/label iteration:** duplicate an experiment with edited instructions and descriptions, and
  diff the results ("variant B gains +6 pts F1 on `account`").
- **Threshold tuning** for yes/no tasks: a PR curve and a slider; show the precision/recall trade-off.
- **Abstention:** "only auto-label when confidence > t". Show coverage against accuracy.
- **Multi-label and score tasks** (Ollaya `score` → ordinal metrics such as MAE and quadratic kappa).
- Larger datasets: streaming import, paginated predictions in SQL instead of in memory.
- Better errors: per-row error reasons, retry failed rows only.

### Phase 2: CLI and automation

- Full CLI parity: `classifai import`, `classifai experiment new --config exp.yaml`,
  `classifai run`, `classifai report --format json|md`, and an exit code on a metric threshold.
- **Headless mode for CI:** fail a pipeline when macro F1 drops below a bar on a golden set.
- Batch classify an unlabelled file: `classifai classify data.csv -m winner > out.csv`.
- Experiment configs as files (YAML) that you can commit and reproduce.

### Phase 3: fine-tuning

Shipped as LoRA training through Unsloth (MLX on Apple silicon), not through Ollaya: Ollaya can't
load new weights (`/api/create` takes calibration temperatures only). See `finetune.rs`.

- A fine-tune starts from an evaluation (dataset, questions, label columns) and a base: Laya
  English/multilingual, Clef Flash, or Qwen3.5 0.8B/2B with a new Clef-style head.
- Split: held-out test (default 20%), calibration (~10% of the rest, temperatures), train.
- Exported as GGUF and served by llama.cpp's `/v1/systemone` (router mode); models are `ft:<slug>`.
- After training, an evaluation on the held-out rows against the base's Ollaya model and the
  source evaluation's local models.
- Next: calibration-only for Ollaya models (`/api/create`), training from labelling sessions
  directly, active learning (label the rows the fine-tune is least sure about), LLM-labelled
  training data.

### Phase 4: collaboration and integrations (exploratory)

- Share an experiment as a static HTML report.
- Active learning: surface the rows where models disagree most and label them in-app.
- Connectors: pull datasets from Postgres, BigQuery, Hugging Face Datasets, Google Sheets.
- Pluggable engines beyond Ollaya (an OpenAI-compatible endpoint as a baseline, or Ollama's decision models).

## Success metrics

| Metric | MVP target |
|---|---|
| Time from install to first quick-check result | < 5 min on a laptop (dominated by model download) |
| Time from CSV to leaderboard (500 rows × 2 encoders, CPU) | < 3 min |
| Experiments per active user per week | ≥ 3 (they iterate) |
| Share of experiments that compare ≥ 2 models | > 70% |

## Key risks

| Risk | Mitigation |
|---|---|
| Ollaya is young (API changes, platform gaps; Windows has no automatic install yet) | Typed client against the documented contract; an engine abstraction in core; use an existing install if present |
| Big decoder models are slow on CPU, so long experiments | Sample size by default (200), CPU-friendly badges, ETA, resumable runs |
| Users' label columns are messy (casing, whitespace, synonyms) | Trimmed values, include/exclude per label; label merge planned in Phase 1 |
| "Fine-tune" over-promises | Clearly marked preview; start with calibration, which Ollaya already supports |
