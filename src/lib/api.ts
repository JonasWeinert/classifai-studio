import type {
  AppSettings,
  BudgetStatus,
  Estimate,
  LabelCorrection,
  QuestionSet,
  QuestionSetPayload,
  QuestionSetSummary,
  ReviewStrategy,
  ThresholdCurve,
  TrackRecord,
  CloudModel,
  CloudModelInput,
  Provider,
  ProviderInput,
  UsageRow,
  AppError,
  CatalogModel,
  Dataset,
  EngineStatus,
  Experiment,
  ExperimentConfig,
  LocalModel,
  Page,
  PredictionRow,
  PresetSummary,
  PullEvent,
  AnyQuestion,
  QuickResult,
  Report,
  Row,
  RunEvent,
  ValueCount,
} from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, cb: (payload: T) => void) => Promise<() => void>;

// In Tauri, talk to Rust. In a plain browser (`pnpm dev`), use an in-memory mock backend so the UI
// can be previewed and designed without the desktop shell.
const backend: Promise<{ invoke: Invoke; listen: Listen }> = isTauri
  ? Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(([core, ev]) => ({
      invoke: core.invoke as Invoke,
      listen: ((event: string, cb: (p: unknown) => void) => ev.listen(event, (e) => cb(e.payload))) as Listen,
    }))
  : import("./mock").then((m) => ({ invoke: m.invoke as Invoke, listen: m.listen as Listen }));

/** Plain error text; see lib/errors.ts `describeError` for actionable messages. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as AppError).message);
  return String(e);
}

const call = async <T>(cmd: string, args?: Record<string, unknown>) => (await backend).invoke<T>(cmd, args);
const listenTo = async <T>(event: string, cb: (p: T) => void) => (await backend).listen<T>(event, cb);

export const api = {
  appInfo: () => call<{ version: string; data_dir: string }>("app_info"),

  engineStatus: () => call<EngineStatus>("engine_status"),
  engineInstall: () => call<EngineStatus>("engine_install"),
  engineStart: () => call<EngineStatus>("engine_start"),
  engineStop: () => call<EngineStatus>("engine_stop"),

  modelsInstalled: () => call<LocalModel[]>("models_installed"),
  modelsCatalog: () => call<CatalogModel[]>("models_catalog"),
  modelPull: (model: string) => call<void>("model_pull", { model }),
  modelDelete: (model: string) => call<void>("model_delete", { model }),
  providers: () => call<Provider[]>("providers_list"),
  providerSave: (input: ProviderInput) => call<Provider>("provider_save", { input }),
  providerDelete: (id: string) => call<void>("provider_delete", { id }),
  providerTest: (id: string) => call<{ ok: boolean; message: string; latency_ms: number }>("provider_test", { id }),
  cloudModelSave: (input: CloudModelInput) => call<CloudModel>("cloud_model_save", { input }),
  cloudModelDelete: (id: string) => call<void>("cloud_model_delete", { id }),
  usageSummary: (since?: string) => call<UsageRow[]>("usage_summary", { since }),
  experimentUsage: (id: string) => call<UsageRow[]>("experiment_usage", { id }),
  presets: () => call<PresetSummary[]>("presets_list"),

  quickClassify: (req: {
    model: string;
    state: string;
    as_json?: boolean;
    questions?: Record<string, AnyQuestion>;
    preset?: string;
  }) => call<QuickResult>("quick_classify", { req }),

  datasetImport: (path: string, name?: string) => call<Dataset>("dataset_import", { path, name }),
  datasets: () => call<Dataset[]>("dataset_list"),
  dataset: (id: string) => call<Dataset>("dataset_get", { id }),
  datasetRows: (id: string, offset: number, limit: number, opts: { search?: string; sortColumn?: string; sortDesc?: boolean } = {}) =>
    call<Page<[number, Row]>>("dataset_rows", { id, offset, limit, search: opts.search, sortColumn: opts.sortColumn, sortDesc: opts.sortDesc }),
  datasetImportText: (name: string, text: string) => call<Dataset>("dataset_import_text", { name, text }),
  valueCounts: (id: string, column: string) => call<ValueCount[]>("dataset_value_counts", { id, column }),
  datasetRename: (id: string, name: string) => call<void>("dataset_rename", { id, name }),
  datasetDelete: (id: string) => call<void>("dataset_delete", { id }),

  experimentCreate: (config: ExperimentConfig) => call<string>("experiment_create", { config }),
  experimentStart: (id: string) => call<void>("experiment_start", { id }),
  experimentCancel: (id: string) => call<void>("experiment_cancel", { id }),
  experiments: (datasetId?: string) => call<Experiment[]>("experiment_list", { datasetId }),
  experiment: (id: string) => call<Experiment>("experiment_get", { id }),
  report: (id: string, question?: string) => call<Report>("experiment_report", { id, question }),
  predictions: (id: string, question: string | undefined, filter: string, offset: number, limit: number) =>
    call<Page<PredictionRow>>("experiment_predictions", { id, question, filter, offset, limit }),
  experimentDelete: (id: string) => call<void>("experiment_delete", { id }),
  exportCsv: (id: string, path: string) => call<number>("experiment_export_csv", { id, path }),
  exportReport: (id: string, path: string, format: "md" | "html") => call<string>("experiment_export_report", { id, path, format }),
  estimate: (config: ExperimentConfig) => call<Estimate>("experiment_estimate", { config }),
  thresholdCurve: (id: string, question: string, model: string) => call<ThresholdCurve>("experiment_threshold_curve", { id, question, model }),
  setThreshold: (id: string, question: string, threshold: number) => call<void>("experiment_set_threshold", { id, question, threshold }),
  reviewQueue: (id: string, question: string, strategy: ReviewStrategy, offset: number, limit: number, confidenceBelow?: number) =>
    call<Page<PredictionRow>>("experiment_review_queue", { id, question, strategy, offset, limit, confidenceBelow }),

  corrections: (datasetId: string) => call<LabelCorrection[]>("label_corrections_list", { datasetId }),
  setCorrection: (datasetId: string, rowIdx: number, column: string, value: string, note?: string | null) =>
    call<void>("label_correction_set", { datasetId, rowIdx, column, value, note }),
  clearCorrection: (datasetId: string, rowIdx: number, column: string) => call<void>("label_correction_clear", { datasetId, rowIdx, column }),

  questionSets: () => call<QuestionSetSummary[]>("question_sets_list"),
  questionSet: (id: string, version?: number) => call<QuestionSet>("question_set_get", { id, version }),
  questionSetSave: (input: { id?: string | null; name: string; description?: string; payload: QuestionSetPayload }) => call<QuestionSetSummary>("question_set_save", { input }),
  questionSetDelete: (id: string) => call<void>("question_set_delete", { id }),

  settings: () => call<AppSettings>("settings_get"),
  settingsSave: (input: AppSettings) => call<AppSettings>("settings_save", { input }),
  budget: () => call<BudgetStatus>("budget_status"),
  trackRecord: () => call<TrackRecord[]>("models_track_record"),
};

export const events = {
  installLog: (cb: (line: string) => void) => listenTo<string>("engine://install-log", cb),
  pull: (cb: (e: PullEvent) => void) => listenTo<PullEvent>("model://pull", cb),
  progress: (cb: (e: RunEvent) => void) => listenTo<RunEvent>("experiment://progress", cb),
  /** Native menu items: "import", "new-experiment", "settings", "palette", "back", "nav:<page>". */
  menu: (cb: (action: string) => void) => listenTo<string>("menu://action", cb),
};

export async function pickFile(): Promise<string | null> {
  if (!isTauri) return "/demo/support_tickets.csv";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({
    multiple: false,
    filters: [{ name: "Data", extensions: ["csv", "tsv", "json", "jsonl", "ndjson"] }],
  });
  return typeof r === "string" ? r : null;
}

export async function pickSavePath(defaultName: string, filter: { name: string; extensions: string[] } = { name: "CSV", extensions: ["csv"] }): Promise<string | null> {
  if (!isTauri) return `/tmp/${defaultName}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [filter] });
}

/** Open a link in the default browser (Tauri) or a new tab (browser preview). */
export async function openExternal(url: string) {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
