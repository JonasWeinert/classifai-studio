# ClassifAI: UX review and improvement plan

Reviewed 2026-10-08 on the current build (sidebar + unified toolbar, beUI controls, multi-question experiments, cloud providers). Every screen was walked through: onboarding, Quick Check, Datasets, Dataset detail, New Experiment, Experiment results, Models (local / cloud / usage), Fine-tune and Engine.

Severity: **P1** blocks or misleads users · **P2** noticeable friction · **P3** polish.

## What already works well

- **One mental model end to end.** Questions, labels, descriptions and models mean the same thing in Quick Check, experiments and the CLI.
- **Honest results.** Macro F1 sits next to accuracy, with calibration (ECE), p50/p95 latency, cost, and an error explorer that defaults to "any wrong".
- **Calm, native-feeling surface.** Controls sit on the background with hairline sections, the title lives in the toolbar, and the motion is purposeful.
- **Good defaults.** The app guesses the label column, picks input columns, writes instructions until you edit them, and uses a deterministic sample of 200 rows.

## Top five problems

1. **Work is easy to lose (P1).** Quick Check questions, input and results live only in page state. Switching to Datasets and back resets everything to the example, and the app always reopens on Quick Check.
2. **Iteration is the core loop, but it's manual (P1).** Improving a classifier means changing wording, re-running and comparing. Today you rebuild an experiment from scratch, and two runs can't be compared.
3. **There's no cost or time estimate before spending (P1).** With cloud models, "Start" can cost real money. The app knows the prices and latencies, but only shows the cost afterwards.
4. **Errors are technical, not actionable (P2).** Messages like `network error: …` or `NO_API_KEY` appear as text. They should say what to do and offer the button to do it, e.g. "Connect OpenAI".
5. **Some macOS conventions are missing (P2).** There's no Settings window (⌘,), no menu-bar commands, no keyboard navigation (⌘1–5, ⌘[, ⌘N), and no drag-and-drop import. The theme toggle sits in the sidebar instead of following the system.

## Findings by area

### Navigation and app shell
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| N1 | The route resets on reload or restart, so the app always opens on Quick Check. | P2 | Restore the last page, the selected experiment question and the Models tab. |
| N2 | No keyboard shortcuts or menu commands. | P2 | Add a native Tauri menu: File → Import Dataset (⌘O), New Experiment (⌘N); View → sections (⌘1–5); Go → Back (⌘[). Add ⌘K for a command palette (beUI ships one). |
| N3 | Settings are scattered: theme in the sidebar, engine in the sidebar, API keys under Models. | P2 | Add a standard Settings window (⌘,) with General (appearance, data folder), Engine and Accounts (provider keys, budget). Keep Models for the catalogue and prices. |
| N4 | "Library" sits under a "Models" group header, which reads oddly; the Engine status dot is the only health signal. | P3 | Rename the item to **Models**, and turn the group header into a status line ("Engine running · 4 local · 2 cloud"). |

### Onboarding
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| O1 | Cloud-only users were trapped in onboarding. **Fixed in this pass:** it now passes when a cloud model is connected, and there's a "Use cloud models instead" link. | P1 | ✅ |
| O2 | The ~1.5 GB download gives no time estimate and offers no choice of model. | P3 | Show the size and an ETA from measured throughput, plus a "smaller: decima:small (0.3 GB)" alternative. |
| O3 | After setup, the user lands on an empty Quick Check with no next step. | P3 | Offer a 30-second "Try it": a sample dataset (the transactions CSV) and a pre-built experiment. |

### Quick Check
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| Q1 | Drafts and results are lost when you navigate away. | P1 | Keep the draft in app state and persist it locally. Results stay until inputs change. |
| Q2 | Editing the input or questions leaves the old results looking current. | P2 | Dim the results and show "Outdated — ⌘↩ to re-run" once anything changes. |
| Q3 | Model selection is at the bottom, below a long question editor, yet it's the most-changed control. | P2 | Move the model picker into the toolbar as a compact multi-select ("3 models ▾"). |
| Q4 | Question sets can't be saved or reused, and Quick Check and experiments don't share them. | P1 | Add **Question sets** (templates): save from Quick Check, start an experiment from one, version them. Bud has templates; for us this is also the hook for research coding schemes. |
| Q5 | Auto-generated question ids (`which_team_should_handle_thi…`) are noise. | P3 | Hide them under the question's disclosure; show them only in export or API views. |
| Q6 | Models run one after another with no overall progress. | P3 | Show "2 of 3 models…" in the toolbar button; run cloud models in parallel with local ones. |
| Q7 | You can't send a dataset row (or a wrong prediction) to Quick Check. | P2 | Add "Open in Quick Check" on rows in the dataset table and the error explorer. |

### Datasets
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| D1 | Import works only through the file picker. | P2 | Allow dropping a file anywhere on the window, and pasting a table copied from Excel or Numbers (TSV on the clipboard). |
| D2 | The row table has no search, sort or filter, and isn't virtualized. | P2 | Use beUI's virtualized Table with sorting, a search field in the toolbar, and a "value = x" filter from the column profile. |
| D3 | The backend can rename datasets but the UI can't. | P3 | Allow editing the name in the toolbar title (double-click). |
| D4 | Tiles don't scale beyond a handful of datasets. | P3 | Switch to a list view, with tiles as an option. |

### New experiment
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| E1 | No cost or time estimate before starting. | P1 | The summary should show "≈ $0.42 · ~3 min", from per-model prices × an estimated tokens/row (sampled) and median latency. Ask for confirmation above a threshold. |
| E2 | Ground-truth labels that differ only in case or whitespace (`Billing`, `billing `) can't be merged. | P2 | Merge suggestions in the labels table, plus drag one label onto another to merge. |
| E3 | Validation shows only as a list in the summary. | P2 | Show the problem next to the offending field, and scroll to it when Start is pressed. |
| E4 | The positive-label control is a native radio button, inconsistent with the beUI controls around it. | P3 | Use beUI's Radio group. |
| E5 | Default yes/no instructions ("This is recurring.") are weak. | P3 | Generate better defaults from the column name and the positive label: "This transaction is recurring (yes)." |

### Experiment results
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| R1 | No way to **duplicate and tweak** an experiment, and no comparison between runs. | P1 | Add "Duplicate…" (opens the setup pre-filled) and a **Compare** view: two experiments side by side, with metric deltas per question and per label. |
| R2 | With several questions there's no overall view; you flip between question tabs. | P2 | Add an "Overall" tab: macro F1 per question × model as a heat-table, plus mean rank. |
| R3 | The leaderboard can't be sorted, and metric help is in `title` tooltips. | P2 | Sortable columns, and beUI Tooltips with one-line plain-language definitions. |
| R4 | Yes/no tasks use a fixed 0.5 threshold. | P2 | A threshold slider with a live precision/recall curve, and "apply" to store it. |
| R5 | Ground-truth mistakes can't be fixed from the error explorer. | P2 | "Mark ground truth wrong / relabel" on a row. Store the corrections and recompute metrics. This is essential for research use (adjudication). |
| R6 | The only export is a CSV of predictions. | P3 | Add a report export (Markdown/HTML/PDF) with config, model versions, metrics, confusion matrices and a methods paragraph, for reproducibility. |

### Models and cost
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| M1 | There's no budget guard for cloud spend. | P2 | A monthly budget in Settings → Accounts, a warning at 80%, and a hard stop option for experiments. |
| M2 | Model cards show public benchmarks but not how the model did **on your data**. | P2 | Show "Best on your data: laya:en, 0.88 F1 on transactions" from past experiments. |
| M3 | Built-in prices go stale. | P3 | Show "prices as of Oct 2026" with a reset-to-default; refresh them from the catalogue in a later version. |
| M4 | macOS may ask permission to read the Keychain after each dev rebuild. | P3 | This goes away in signed builds; note it in the dev docs. |

### Visual and accessibility
| # | Finding | Sev | Recommendation |
|---|---|---|---|
| V1 | Tertiary text (`--faint` #a1a1a6 on white) is about 2.6:1 contrast at 11 px, which fails WCAG AA. | P2 | Darken it to #8a8a8f (or use it only for non-essential text), and set a minimum size of 11.5 px. |
| V2 | Models are distinguished by colour dot only. | P2 | Always pair the colour with the model name (already true in most places). Add shape markers in charts for colour-vision deficiency. |
| V3 | Loading states mix spinners and shimmer. | P3 | Use skeletons for content areas and the spinner only inside buttons. |
| V4 | Tables, the segmented controls and the sidebar have no full keyboard focus order. | P2 | Audit tab order, add arrow-key navigation in tables and the sidebar, and use visible focus rings everywhere. |

## Improvement plan

### Phase A: quick wins (≈ 2–3 days)
1. **Persistence:** Quick Check draft and results, last route, last Models tab, the selected question in results (Q1, N1).
2. **Outdated-results state** in Quick Check (Q2); model picker in the toolbar (Q3).
3. **Actionable errors:** map error codes to plain messages with action buttons (NO_API_KEY → Connect, ENGINE_OFFLINE → Start engine, MODEL_NOT_FOUND → Download).
4. **Cost and time estimate** before starting an experiment, with confirmation above $1 (E1).
5. **macOS conventions:** native menu and shortcuts, a Settings window (⌘,) holding appearance, engine and accounts, drag-and-drop import (N2, N3, D1).
6. Visual fixes: contrast, beUI Radio, inline validation (V1, E4, E3).

### Phase B: the iteration loop (≈ 1–2 weeks)
1. **Question sets** shared by Quick Check and experiments, with versions (Q4).
2. **Duplicate and Compare experiments**, with per-question and per-label deltas (R1).
3. Overall cross-question view, sortable leaderboard, metric tooltips (R2, R3).
4. Yes/no threshold tuning (R4); merging label variants (E2).
5. "Open in Quick Check" from dataset rows and wrong predictions (Q7).
6. Dataset table: virtualized, sortable, searchable (D2).
7. Budget guard for cloud spend (M1).

### Phase C: research-grade, toward the social-science / academic direction
1. **Adjudication:** relabel ground truth from the error explorer, keep a correction log, and recompute (R5).
2. **Agreement statistics:** Cohen's / Fleiss' κ between models and between models and human coders, as in content-analysis reporting.
3. **Reproducible reports:** config, model versions, sample seed, metrics and a methods paragraph, exported as Markdown/PDF (R6).
4. **Screening workflow** (systematic reviews): include/exclude with reasons, a "needs human review" queue driven by confidence, and recall-first thresholds.
5. Command palette and full keyboard operation (N2, V4).

### How to measure it
- **Time to first result** from a fresh install, and from opening the app to a re-run.
- **Iterations per session**: experiments created by duplicating, divided by all experiments.
- **Abandoned setups**: New Experiment opened but not started.
- **Error recovery**: errors followed by the suggested action within 30 seconds.
