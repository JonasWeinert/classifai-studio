import type {
  SheetPreview,
  HfImportSpec,
  HfInfo,
  HfProgress,
  LabelMark,
  LabelSnippet,
  RemoteModel,
  CliStatus,
  LabelSession,
  LabelSessionInput,
  LabelSessionSummary,
  LabelValue,
  BulkRun,
  BulkRunInput,
  BulkRunSummary,
  Question,
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
  FineTune,
  FineTuneBase,
  FineTuneInput,
  FineTunePreview,
  TrainerStatus,
  AnalysisRow,
} from "./types";

import { track } from "./modelStatus";

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
  cliStatus: () => call<CliStatus>("cli_status"),
  cliInstall: (replace = false) => call<CliStatus>("cli_install", { replace }),
  cliUninstall: () => call<CliStatus>("cli_uninstall"),
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
  providerModels: (id: string) => call<RemoteModel[]>("provider_models", { id }),
  providerTest: (id: string) => call<{ ok: boolean; message: string; latency_ms: number }>("provider_test", { id }),
  cloudModelSave: (input: CloudModelInput) => call<CloudModel>("cloud_model_save", { input }),
  cloudModelDelete: (id: string) => call<void>("cloud_model_delete", { id }),
  usageSummary: (since?: string) => call<UsageRow[]>("usage_summary", { since }),
  experimentUsage: (id: string) => call<UsageRow[]>("experiment_usage", { id }),
  presetShow: (name: string) => call<Record<string, Question>>("preset_show", { name }),
  readTextFile: (path: string) => call<string>("read_text_file", { path }),
  saveTextFile: (path: string, contents: string) => call<void>("save_text_file", { path, contents }),
  presets: () => call<PresetSummary[]>("presets_list"),

  quickClassify: (req: {
    model: string;
    state: string;
    as_json?: boolean;
    questions?: Record<string, AnyQuestion>;
    preset?: string;
  }) => track(req.model, call<QuickResult>("quick_classify", { req })),
  modelsLoaded: () => call<string[]>("models_loaded"),

  datasetImport: (path: string, name?: string) => call<Dataset>("dataset_import", { path, name }),
  datasets: () => call<Dataset[]>("dataset_list"),
  dataset: (id: string) => call<Dataset>("dataset_get", { id }),
  datasetRows: (id: string, offset: number, limit: number, opts: { search?: string; sortColumn?: string; sortDesc?: boolean } = {}) =>
    call<Page<[number, Row]>>("dataset_rows", { id, offset, limit, search: opts.search, sortColumn: opts.sortColumn, sortDesc: opts.sortDesc }),
  spreadsheetInspect: (path: string) => call<SheetPreview[]>("spreadsheet_inspect", { path }),
  spreadsheetImport: (path: string, sheet: string, headerRow: number, columns: number[], name?: string) => call<Dataset>("spreadsheet_import", { path, sheet, headerRow, columns, name }),
  filesImport: (paths: string[], name?: string) => call<{ dataset: Dataset; skipped: { path: string; reason: string }[] }>("files_import", { paths, name }),
  datasetImportText: (name: string, text: string) => call<Dataset>("dataset_import_text", { name, text }),
  datasetCreate: (name: string, columns: string[], rows: Row[]) => call<Dataset>("dataset_create", { name, columns, rows }),
  /** A dataset linked to `parentId` that stores only the added cells: rows are [parent row index, cells]. */
  datasetDerive: (parentId: string, name: string, rows: [number, Row][], source?: string) => call<Dataset>("dataset_derive", { parentId, name, rows, source }),
  columnProfile: (id: string, column: string, limit?: number) => call<{ rows: number; empty: number; distinct: number; top: ValueCount[] }>("dataset_column_profile", { id, column, limit }),
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
  experimentSaveAsDataset: (id: string, name: string) => call<Dataset>("experiment_save_as_dataset", { id, name }),
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
  questionSetSave: (input: { id?: string | null; name: string; description?: string; payload: QuestionSetPayload; amend?: boolean }) => call<QuestionSetSummary>("question_set_save", { input }),
  questionSetDelete: (id: string) => call<void>("question_set_delete", { id }),

  bulkRuns: () => call<BulkRunSummary[]>("bulk_runs_list"),
  bulkRun: (id: string) => call<BulkRun>("bulk_run_get", { id }),
  bulkRunCreate: (input: BulkRunInput) => call<BulkRunSummary>("bulk_run_create", { input }),
  bulkResultsPut: (id: string, results: { pos: number; answers?: unknown; error?: unknown; latency_ms?: number | null; cost_usd?: number | null }[]) => call<void>("bulk_results_put", { id, results }),
  bulkRunFinish: (id: string, status: "completed" | "cancelled") => call<void>("bulk_run_finish", { id, status }),
  bulkRunRename: (id: string, name: string) => call<void>("bulk_run_rename", { id, name }),
  bulkRunSetSaved: (id: string, datasetId: string | null) => call<void>("bulk_run_set_saved", { id, datasetId }),
  bulkRunDelete: (id: string) => call<void>("bulk_run_delete", { id }),

  hfInfo: (dataset: string) => call<HfInfo>("hf_info", { dataset }),
  hfImport: (spec: HfImportSpec) => call<Dataset[]>("hf_import", { spec }),
  hfCancel: () => call<void>("hf_cancel"),
  hfTokenStatus: () => call<string | null>("hf_token_status"),
  hfTokenSet: (token: string) => call<void>("hf_token_set", { token }),

  labelSessions: () => call<LabelSessionSummary[]>("label_sessions_list"),
  labelSession: (id: string) => call<LabelSession>("label_session_get", { id }),
  labelSessionCreate: (input: LabelSessionInput) => call<LabelSessionSummary>("label_session_create", { input }),
  labelAnswerSet: (id: string, rowIdx: number, questionId: string, value: LabelValue | null) => call<void>("label_answer_set", { id, rowIdx, questionId, value }),
  labelMarkSet: (id: string, rowIdx: number, mark: LabelMark) => call<void>("label_mark_set", { id, rowIdx, mark }),
  labelEvidenceSet: (id: string, rowIdx: number, questionId: string, snippets: LabelSnippet[]) => call<void>("label_evidence_set", { id, rowIdx, questionId, snippets }),
  labelPositionSet: (id: string, position: number) => call<void>("label_position_set", { id, position }),
  labelSessionUpdate: (id: string, patch: { name?: string; columns?: string[]; questions?: QuestionSetPayload; titles?: Record<string, string> }) => call<void>("label_session_update", { id, ...patch }),
  labelSessionSetSaved: (id: string, datasetId: string | null) => call<void>("label_session_set_saved", { id, datasetId }),
  labelSessionDelete: (id: string) => call<void>("label_session_delete", { id }),
  datasetRowsAt: (id: string, indices: number[]) => call<[number, Row][]>("dataset_rows_at", { id, indices }),

  uiState: () => call<Record<string, unknown>>("ui_state_get"),
  uiStateSet: (key: string, value: unknown) => call<void>("ui_state_set", { key, value }),

  settings: () => call<AppSettings>("settings_get"),
  settingsSave: (input: AppSettings) => call<AppSettings>("settings_save", { input }),
  budget: () => call<BudgetStatus>("budget_status"),
  trackRecord: () => call<TrackRecord[]>("models_track_record"),

  fineTuneBases: () => call<FineTuneBase[]>("finetune_bases"),
  trainerStatus: () => call<TrainerStatus>("trainer_status"),
  trainerInstall: () => call<TrainerStatus>("trainer_install"),
  trainerUninstall: () => call<TrainerStatus>("trainer_uninstall"),
  fineTunes: () => call<FineTune[]>("finetune_list"),
  fineTune: (id: string) => call<FineTune>("finetune_get", { id }),
  fineTunePreview: (config: ExperimentConfig, holdout: number, base?: string) => call<FineTunePreview>("finetune_preview", { config, holdout, base }),
  fineTuneCreate: (input: FineTuneInput) => call<FineTune>("finetune_create", { input }),
  fineTuneCancel: (id: string) => call<void>("finetune_cancel", { id }),
  fineTuneDelete: (id: string) => call<void>("finetune_delete", { id }),
  fineTuneLog: (id: string) => call<string>("finetune_log", { id }),
  fineTuneFolder: (id: string) => call<string>("finetune_folder", { id }),
  fineTuneAnalysis: (id: string) => call<{ rows: AnalysisRow[] }>("finetune_analysis", { id }),
};

export const events = {
  installLog: (cb: (line: string) => void) => listenTo<string>("engine://install-log", cb),
  pull: (cb: (e: PullEvent) => void) => listenTo<PullEvent>("model://pull", cb),
  progress: (cb: (e: RunEvent) => void) => listenTo<RunEvent>("experiment://progress", cb),
  hfProgress: (cb: (e: HfProgress) => void) => listenTo<HfProgress>("hf://progress", cb),
  /** Every change of a fine-tune (the whole fine-tune). */
  fineTune: (cb: (f: FineTune) => void) => listenTo<FineTune>("finetune://progress", cb),
  trainerLog: (cb: (line: string) => void) => listenTo<string>("finetune://install-log", cb),
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

export const SPREADSHEET_EXTENSIONS = ["csv", "tsv", "json", "jsonl", "ndjson", "xlsx", "xlsm", "xlsb", "xls", "ods"];
export const WORKBOOK_EXTENSIONS = ["xlsx", "xlsm", "xlsb", "xls", "ods"];
export const DOCUMENT_EXTENSIONS = ["txt", "md", "markdown", "docx", "pdf"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic"];
export const extOf = (path: string) => path.split(/[\\/]/).pop()!.split(".").pop()!.toLowerCase();

/** Choose one or more files. */
export async function pickFiles(filters: { name: string; extensions: string[] }[], multiple = true): Promise<string[]> {
  if (!isTauri) {
    const exts = filters.flatMap((f) => f.extensions);
    if (exts.includes("xlsx") && !exts.includes("pdf")) return ["/demo/tickets.xlsx"];
    if (exts.includes("json")) return ["/demo/screening.schema.json"];
    return ["/demo/Quarterly report.docx", "/demo/paper.pdf", "/demo/notes.md", "/demo/receipt-photo.png"];
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple, filters });
  return r === null ? [] : Array.isArray(r) ? r : [r];
}

/** A URL the webview can load for a file in the app's media folder (or any URL as it is). */
export function fileSrc(path: string): string {
  if (!isTauri || /^(https?|data|blob|asset):/i.test(path)) return path;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string, protocol?: string) => string } }).__TAURI_INTERNALS__;
  return internals?.convertFileSrc ? internals.convertFileSrc(path, "asset") : path;
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
