// Mirrors the Rust types in crates/classifai-core and src-tauri/src/commands.rs.

export type Question =
  | { type: "choice"; instructions?: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions?: string; criteria: string[] }
  | { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } };

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
    }
  | { type: "noul"; noul: number };

/** Extended question types, expanded into primitives in classifai-core (questions.rs). */
export type AnyQuestion =
  | Question
  | { type: "multi"; instructions?: string; criteria: Record<string, string | null>; threshold?: number }
  | { type: "rank"; instructions?: string; criteria: Record<string, string | null> }
  | { type: "number"; instructions?: string; values: number[]; unit?: string | null };

export type AnyAnswer =
  | Answer
  | { type: "multi"; selected: string[]; threshold: number; probabilities: Record<string, number> }
  | { type: "rank"; ranking: string[]; confidence: number; probabilities: Record<string, number> }
  | {
      type: "number";
      estimate: number;
      most_likely: number;
      range: [number, number];
      unit: string | null;
      confidence: number;
      probabilities: Record<string, number>;
    };

export interface EngineStatus {
  installed: boolean;
  binary_path: string | null;
  managed: boolean;
  running: boolean;
  owned_process: boolean;
  version: string | null;
  base_url: string;
}

export interface LocalModel {
  name: string;
  modified_at: string;
  size: number;
  details: { format: string; family: string; parameter_size: string; quantization_level: string };
}

export interface CatalogModel {
  name: string;
  title: string;
  description: string;
  kind: "encoder" | "decoder";
  params: string;
  approx_size_gb: number;
  cpu_friendly: boolean;
  recommended: boolean;
  tags: string[];
}

export type ProviderKind = "typesafe" | "openai" | "cloudflare" | "custom";

/** A hosted decision model. `id` is "@{provider}/{model}" and is used wherever a model name is. */
export interface CloudModel {
  id: string;
  /** Published price this model shipped with (for "reset to default"); null for custom models. */
  default_input_price_per_mtok?: number | null;
  default_output_price_per_mtok?: number | null;
  provider_id: string;
  model: string;
  display_name: string;
  description: string;
  input_price_per_mtok: number;
  output_price_per_mtok: number;
  enabled: boolean;
  builtin: boolean;
}

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  base_url: string | null;
  account_id: string | null;
  has_key: boolean;
  key_hint: string | null;
  builtin: boolean;
  models: CloudModel[];
}

export interface ProviderInput {
  id?: string | null;
  kind: ProviderKind;
  name: string;
  base_url?: string | null;
  account_id?: string | null;
  /** undefined/null = keep, "" = delete, otherwise store in the keychain */
  api_key?: string | null;
}

export interface CloudModelInput {
  provider_id: string;
  model: string;
  display_name?: string | null;
  input_price_per_mtok: number;
  output_price_per_mtok: number;
  enabled: boolean;
}

export interface UsageRow {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface PullEvent {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error: string | null;
}

export interface PresetSummary {
  name: string;
  builtin: boolean;
  description: string | null;
  questions: string[];
}

export interface QuickResult {
  model: string;
  answered_by: string;
  answers: Record<string, AnyAnswer>;
  routing: { router: string; model: string; route: string; reason: string } | null;
  latency_ms: number;
  load_ms: number;
  state_truncated: boolean;
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  refused?: string[];
}

export interface Dataset {
  id: string;
  name: string;
  source: string | null;
  columns: string[];
  row_count: number;
  created_at: string;
}

export type Row = Record<string, string>;

export interface ValueCount {
  value: string;
  count: number;
}

export type TaskKind = "choice" | "binary";

export interface LabelSpec {
  value: string;
  description?: string | null;
  /** Other ground-truth spellings that count as this label (e.g. "Billing", "billing "). */
  aliases?: string[];
}

export interface TaskSpec {
  /** Question id, unique within the experiment (also the Ollaya question key). */
  id: string;
  kind: TaskKind;
  instructions: string;
  /** Extra context for this question, appended to its instructions. */
  context?: string | null;
  label_column: string;
  labels: LabelSpec[];
  positive_label?: string | null;
  threshold?: number | null;
}

export interface ExperimentConfig {
  name: string;
  dataset_id: string;
  input_columns: string[];
  /** Context shared by every question. */
  context?: string | null;
  tasks: TaskSpec[];
  models: string[];
  sample_size?: number | null;
  concurrency?: number | null;
}

export type ExperimentStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface Experiment {
  id: string;
  name: string;
  dataset_id: string;
  dataset_name: string;
  config: ExperimentConfig;
  status: ExperimentStatus;
  error: string | null;
  row_indices: number[];
  progress: Record<string, number>;
  created_at: string;
  finished_at: string | null;
}

export interface RunEvent {
  experiment_id: string;
  model: string | null;
  done: number;
  total: number;
  status: ExperimentStatus;
  message: string | null;
}

export interface ClassMetrics {
  label: string;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  mean_confidence: number;
  accuracy: number;
}

export interface ModelMetrics {
  model: string;
  evaluated: number;
  errors: number;
  accuracy: number;
  macro_precision: number;
  macro_recall: number;
  macro_f1: number;
  weighted_f1: number;
  mean_confidence: number;
  ece: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_mean_ms: number;
  per_class: ClassMetrics[];
  confusion: number[][];
  calibration: CalibrationBin[];
  /** Cohen's kappa between this model's predictions and the ground truth. */
  kappa: number;
}

export interface Report {
  question_id: string;
  labels: string[];
  models: ModelMetrics[];
  agreement: number[][];
  /** Cohen's kappa between each pair of models (same order as models). */
  pairwise_kappa: number[][];
  /** Fleiss' kappa across all models (null with fewer than 2 models). */
  fleiss_kappa: number | null;
  /** Rows whose ground truth was corrected or confirmed by a human. */
  reviewed_rows: number;
}

export interface ModelCell {
  predicted: string | null;
  confidence: number | null;
  error: string | null;
}

export interface PredictionRow {
  row_idx: number;
  input: string;
  ground_truth: string;
  by_model: Record<string, ModelCell>;
  /** Set when a human corrected or confirmed the ground truth of this row. */
  corrected?: boolean;
  original_ground_truth?: string | null;
  review_note?: string | null;
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface AppError {
  code: string;
  message: string;
}

// ---- Phase A/B/C contract ------------------------------------------------------------------------

export interface EstimateModel {
  model: string;
  est_input_tokens: number;
  est_cost_usd: number;
  est_seconds: number;
}

export interface Estimate {
  rows: number;
  requests: number;
  per_model: EstimateModel[];
  total_cost_usd: number;
  /** Wall-clock estimate; models run one after another. */
  total_seconds: number;
}

/** Saved, versioned question set (template). `payload` is owned by the frontend (see QuestionSetPayload). */
export interface QuestionSetSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  question_count: number;
  updated_at: string;
}

export interface QuestionSet extends Omit<QuestionSetSummary, "question_count"> {
  payload: QuestionSetPayload;
}

export interface QuestionSetPayload {
  context: string;
  questions: SetQuestion[];
}

/** One question in a set — the editor's draft shape, shared by Playground and New Experiment. */
export interface SetQuestion {
  kind: "choice" | "multi" | "noul" | "score" | "rank" | "number";
  text: string;
  context: string;
  options: { name: string; description: string }[];
  threshold: number;
  yes: string;
  no: string;
  levels: string[];
  values: string;
  unit: string;
}

export interface ThresholdPoint {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

export interface ThresholdCurve {
  points: ThresholdPoint[];
  current: number;
}

export interface AppSettings {
  monthly_budget_usd: number | null;
  /** Refuse cloud requests once the monthly budget is used up. */
  budget_hard_stop: boolean;
}

export interface BudgetStatus {
  month_spend_usd: number;
  budget_usd: number | null;
  /** spend / budget, null without a budget */
  ratio: number | null;
  exceeded: boolean;
}

export interface LabelCorrection {
  row_idx: number;
  column: string;
  original: string;
  value: string;
  note: string | null;
  at: string;
}

export interface TrackRecord {
  model: string;
  experiment_id: string;
  experiment_name: string;
  question_id: string;
  macro_f1: number;
  accuracy: number;
}

export type ReviewStrategy = "disagree" | "low_confidence" | "wrong";
