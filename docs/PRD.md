# ClassifAI: product requirements (v0.1 MVP)

Status: **Draft for review** · Owner: Jonas · Last updated: 2026-10-08
Related: [PRODUCT_PLAN.md](PRODUCT_PLAN.md) (vision and roadmap), [Ollaya API contract](https://github.com/ollaya-dev/ollaya/blob/main/docs/api.md)

## 1. Summary

ClassifAI is a Tauri desktop app for classifying data with local decision models served by
[Ollaya](https://github.com/ollaya-dev/ollaya). Users import a labelled dataset, choose which column
is ground truth and which columns are input, pick several models and get a side-by-side evaluation.
A quick-check screen classifies a single entry. A CLI shares the same core. Fine-tuning is a mockup
in this version.

## 2. Goals and non-goals

**Goals (MVP)**
- G1. Go from a fresh install to the first classification without a terminal (the engine installs itself).
- G2. Evaluate N models on a labelled dataset and rank them on quality, calibration and speed.
- G3. Classify one entry with several models in under 2 s, once the models are loaded.
- G4. One Rust core shared by the desktop app and the CLI, with the same database and engine.

**Non-goals (MVP)**
- Training or fine-tuning (mockup only).
- Multi-label classification, regression, and `score` tasks in experiments (quick check supports `score`).
- Cloud sync, accounts, sharing.
- Automatic Windows install of Ollaya (manual install is detected).

## 3. Users and key scenarios

1. **Pick a model for ticket routing.** Import `tickets.csv` (subject, body, team) → ground truth
   `team`, inputs `subject + body` → laya, nli, winnow:e4b on 500 rows → laya:en has the best macro
   F1 at 9× lower latency than winnow → export the CSV of errors to review.
2. **Sanity-check a label set.** In quick check, paste a message, define labels with descriptions,
   compare three models, tweak a description, and run again.
3. **Spam yes/no.** A binary task with `spam` as the positive label. ClassifAI asks an Ollaya `noul`
   question and thresholds P(yes) at 0.5.

## 4. Functional requirements

### 4.1 Engine (Ollaya) lifecycle
| ID | Requirement | Acceptance |
|---|---|---|
| E1 | On launch, detect Ollaya: the managed copy in `<app data>/engine/bin`, then `PATH`, `/usr/local/bin`, `/opt/homebrew/bin` and `~/.local/bin`; also a daemon already answering at `OLLAYA_HOST` (default `127.0.0.1:11435`) | The status shows installed/running/version/binary path |
| E2 | First-launch onboarding: install → start → pull starter model (`laya`) | Done in ≤ 3 clicks; installer output is streamed live |
| E3 | Install runs the official `install.sh` with `OLLAYA_INSTALL_DIR=<app data>/engine` and `OLLAYA_NO_SERVICE=1` | No sudo, no system service, no shell-profile edits |
| E4 | Start `ollaya serve` as a child process if none answers; stop it on app exit only if the app started it | An external daemon is never killed |
| E5 | Engine page: status, version, binary, Start/Stop/Update | ✅ |

### 4.2 Models
| ID | Requirement |
|---|---|
| M1 | List installed models (`GET /api/tags`) with format, size and parameters |
| M2 | Curated catalog (13 models) with CPU-friendly or GPU badges and a "recommended" flag |
| M3 | Pull any model name, with streaming byte progress (`POST /api/pull`); several pulls can run at once |
| M4 | Remove a model (`DELETE /api/delete`) |

### 4.3 Quick check
| ID | Requirement |
|---|---|
| Q1 | Input as plain text, or JSON (sent as an object `state`) |
| Q2 | Question modes: **Labels** (`choice` with optional descriptions), **Yes/No** (`noul`), **Scale** (`score`, 2–10 levels), **Preset** (Ollaya built-in or custom presets) |
| Q3 | Run on N models, one after another; each result appears as it arrives (answer, confidence, probability bars, latency, load time, router target) |
| Q4 | Consensus banner: whether the models agree |
| Q5 | ⌘↩ runs the check |

### 4.4 Datasets
| ID | Requirement | Acceptance |
|---|---|---|
| D1 | Import `.csv` (delimiter sniffed: `,` `;` tab `\|`), `.tsv`, `.json` (an array, or the first array in an object), `.jsonl`/`.ndjson` | BOM, duplicate or empty headers and ragged rows are handled; ≤ 200k rows |
| D2 | Stored in SQLite; the original file is not modified | |
| D3 | Paginated row browser; click a column to profile it (distinct values, distribution, "looks like labels") | |
| D4 | Rename and delete (cascades to experiments) | |

### 4.5 Experiments
| ID | Requirement | Acceptance |
|---|---|---|
| X1 | Configure: dataset, **ground-truth column**, **input column(s)** (one → string state, several → JSON object state), task kind (pick-one / yes-no), instructions, labels (auto-detected values, include/exclude, optional description each), positive label for yes/no, models, sample size, name | Validation blocks a bad config with a clear reason |
| X2 | Only rows whose trimmed ground truth is an included label are eligible. The sample is a **deterministic** random subset, so reruns are comparable | |
| X3 | Run in the background: each model is loaded once, then rows run with 4 concurrent requests; predictions are persisted as they arrive | The UI stays responsive; progress per model |
| X4 | Cancel; **resume** skips rows that already have predictions; experiments interrupted by quitting the app are marked "Stopped" on the next launch | |
| X5 | A model that fails to load records an error for each of its rows; the other models continue | |

### 4.6 Results and comparison
| ID | Requirement |
|---|---|
| R1 | Leaderboard ranked by macro F1: accuracy, macro F1, weighted F1, macro precision/recall, ECE (10 bins), p50/p95 latency, error count. The best value in each column is highlighted; a winner callout shows the margin and the speed ratio |
| R2 | Bar charts for accuracy, macro F1 and median latency |
| R3 | Per model: confusion matrix (counts, row-normalized shading), per-label precision/recall/F1, reliability diagram |
| R4 | Pairwise model agreement matrix |
| R5 | Prediction explorer with filters: any wrong / wrong by a chosen model / disagreements / all; paginated; expand the input |
| R6 | Export a CSV: row, input, ground truth, and per model the prediction, confidence and correctness |
| R7 | Metrics refresh live while an experiment runs |

### 4.7 Fine-tune (mockup)
| ID | Requirement |
|---|---|
| F1 | A visual mockup of the planned flow (method: calibrate / head / LoRA; base model; data; split; hyperparameters; loss chart; before/after), clearly labelled as not functional |

### 4.8 CLI (preview)
`classifai status | models | pull <m> | check "<text>" -m <model>… (-l a,b,c | --yes-no "<stmt>") | datasets | experiments | report <id> | run <id>`.
It reads `OLLAYA_HOST` and shares the database with the app.

## 5. Architecture

```
┌──────────────── Tauri desktop (src-tauri) ─────────────────┐     ┌── CLI (crates/classifai-cli) ──┐
│ React + TS + Tailwind UI (src/)  ⇄  Tauri commands/events │     │ clap commands                  │
└───────────────────────────────┬────────────────────────────┘     └───────────────┬────────────────┘
                                └──────────────┬──────────────────────────────────┘
                                   classifai-core (Rust crate)
          ollaya (HTTP client) · engine (install/start) · dataset (parsers) · store (SQLite)
          task (row → question) · runner (rows × models, cancel/resume) · eval (metrics) · catalog
                                               │ HTTP, localhost:11435
                                     Ollaya daemon (child process or external)
```

- **Why a Rust core and not logic in the frontend?** The CLI and future headless/CI use need the
  same behaviour. Long runs must survive UI reloads. SQLite access stays in one place.
- **Engine boundary.** Only `ollaya.rs` knows Ollaya's wire format (TypeSafe-compatible `choice` /
  `score` / `noul`). `task.rs` maps a classification task onto it. Another engine later means
  another client behind the same task and runner types.
- **Storage.** `<app data>/classifai.db` (macOS: `~/Library/Application Support/dev.classifai.app`)
  has the tables `datasets`, `dataset_rows` (JSON per row), `experiments` (config JSON, sampled row
  indices, status) and `predictions` (per experiment × model × row: predicted label, confidence, top
  probability, probabilities JSON, latency, error). Metrics are computed on read, so metric changes
  apply retroactively.
- **Events.** `engine://install-log`, `model://pull`, `experiment://progress`.
- **Browser preview.** Outside Tauri, `src/lib/mock.ts` stands in for the backend (`pnpm dev`;
  `?fresh` simulates a first launch). `scripts/fake_ollaya.py` stands in for Ollaya in Rust tests.

## 6. Metric definitions

- **Accuracy**: correct / answered (rows that errored are excluded and counted separately).
- **Macro P/R/F1**: unweighted mean over labels present in the ground truth.
- **Weighted F1**: mean F1 weighted by label support.
- **Confidence**: TypeSafe-normalized top probability, (K·p_max − 1)/(K − 1); for yes/no, |2p − 1|.
- **ECE**: 10 equal-width bins over the **top probability**; Σ (n_b/N)·|acc_b − conf_b|.
- **Latency**: Ollaya's `eval_duration` per row (runner time, excluding queueing and load); wall
  clock is the fallback.
- **Agreement**: share of rows that both models answered with the same label.

## 7. Non-functional requirements

- **Privacy:** no telemetry; no network traffic except the Ollaya installer and model downloads.
- **Performance:** the UI never blocks on inference; 10k-row experiments stream to disk.
- **Platforms:** macOS (Apple silicon) first-class; Linux supported; Windows needs a manual Ollaya install.
- **Resilience:** per-row errors never abort an experiment; the app can be closed mid-run and resumed.

## 8. Open questions

See the questions in the hand-off message; answers will be folded back into this document.

## 9. Known limitations of this scaffold

- Predictions filtering and joining happen in memory per request. That is fine up to ~50k rows ×
  models; move it to SQL in Phase 1.
- Ollaya preset questions in quick check are rendered generically; experiments support one question.
- No ETA yet; no "retry failed rows only".
- The catalog is hard-coded from Ollaya's README; it should come from `ollaya.dev/search` later.
