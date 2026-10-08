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
  answers: Record<string, Answer>;
  routing: { router: string; model: string; route: string; reason: string } | null;
  latency_ms: number;
  load_ms: number;
  state_truncated: boolean;
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
}

export interface TaskSpec {
  kind: TaskKind;
  instructions: string;
  input_columns: string[];
  label_column: string;
  labels: LabelSpec[];
  positive_label?: string | null;
  threshold?: number | null;
}

export interface ExperimentConfig {
  name: string;
  dataset_id: string;
  task: TaskSpec;
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
}

export interface Report {
  labels: string[];
  models: ModelMetrics[];
  agreement: number[][];
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
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface AppError {
  code: string;
  message: string;
}
