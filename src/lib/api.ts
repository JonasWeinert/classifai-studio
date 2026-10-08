import type {
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
  Question,
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
  presets: () => call<PresetSummary[]>("presets_list"),

  quickClassify: (req: {
    model: string;
    state: string;
    as_json?: boolean;
    questions?: Record<string, Question>;
    preset?: string;
  }) => call<QuickResult>("quick_classify", { req }),

  datasetImport: (path: string, name?: string) => call<Dataset>("dataset_import", { path, name }),
  datasets: () => call<Dataset[]>("dataset_list"),
  dataset: (id: string) => call<Dataset>("dataset_get", { id }),
  datasetRows: (id: string, offset: number, limit: number) =>
    call<Page<[number, Row]>>("dataset_rows", { id, offset, limit }),
  valueCounts: (id: string, column: string) => call<ValueCount[]>("dataset_value_counts", { id, column }),
  datasetRename: (id: string, name: string) => call<void>("dataset_rename", { id, name }),
  datasetDelete: (id: string) => call<void>("dataset_delete", { id }),

  experimentCreate: (config: ExperimentConfig) => call<string>("experiment_create", { config }),
  experimentStart: (id: string) => call<void>("experiment_start", { id }),
  experimentCancel: (id: string) => call<void>("experiment_cancel", { id }),
  experiments: (datasetId?: string) => call<Experiment[]>("experiment_list", { datasetId }),
  experiment: (id: string) => call<Experiment>("experiment_get", { id }),
  report: (id: string) => call<Report>("experiment_report", { id }),
  predictions: (id: string, filter: string, offset: number, limit: number) =>
    call<Page<PredictionRow>>("experiment_predictions", { id, filter, offset, limit }),
  experimentDelete: (id: string) => call<void>("experiment_delete", { id }),
  exportCsv: (id: string, path: string) => call<number>("experiment_export_csv", { id, path }),
};

export const events = {
  installLog: (cb: (line: string) => void) => listenTo<string>("engine://install-log", cb),
  pull: (cb: (e: PullEvent) => void) => listenTo<PullEvent>("model://pull", cb),
  progress: (cb: (e: RunEvent) => void) => listenTo<RunEvent>("experiment://progress", cb),
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

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return `/tmp/${defaultName}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: "CSV", extensions: ["csv"] }] });
}
