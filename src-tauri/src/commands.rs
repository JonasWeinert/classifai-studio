//! Tauri commands: a thin layer over `classifai-core`. Errors serialize as `{ code, message }`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use classifai_core::analysis::{self, Estimate, PredictionsPage, ThresholdCurve, TrackRecord};
use classifai_core::bulk::{BulkResult, BulkRun, BulkRunInput, BulkRunSummary};
use classifai_core::catalog::{CatalogModel, CATALOG};
use classifai_core::hf::{HfClient, HfImportSpec, HfInfo};
use classifai_core::labelling::{LabelMark, LabelSession, LabelSessionInput, LabelSessionSummary, LabelSnippet};
use classifai_core::secrets::{KeychainSecrets, SecretStore};
use classifai_core::dataset;
use classifai_core::documents;
use classifai_core::spreadsheet::{self, SheetPreview};
use classifai_core::decider::{ProviderTest, UsageContext};
use classifai_core::engine::EngineStatus;
use classifai_core::eval::Report;
use classifai_core::export;
use classifai_core::ollaya::{LocalModel, PresetSummary, Routing, Usage};
use classifai_core::providers::{CloudModelInput, CloudModelView, ProviderInput, ProviderView};
use classifai_core::questions::{self, AnyAnswer, AnyQuestion};
use classifai_core::runner::{self, RunEvent};
use classifai_core::store::{
    AppSettings, BudgetStatus, ColumnProfile, Dataset, Experiment, ExperimentConfig, ExperimentStatus, LabelCorrection, QuestionSet,
    QuestionSetInput, QuestionSetSummary, UsageRow, ValueCount,
};
use classifai_core::{Error, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

/// Run store work off the main thread (sync commands run on it in Tauri).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| Error::invalid(e.to_string()))?
}

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    data_dir: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: app.path().app_data_dir().map(|p| p.display().to_string()).unwrap_or_default(),
    })
}

// ---- command line tool ----------------------------------------------------------------------

#[tauri::command]
pub fn cli_status() -> crate::cli_install::CliStatus {
    crate::cli_install::status()
}

/// Link the bundled `classifai` into /usr/local/bin (macOS asks for a password when needed).
#[tauri::command]
pub async fn cli_install(replace: bool) -> Result<crate::cli_install::CliStatus> {
    tauri::async_runtime::spawn_blocking(move || crate::cli_install::install(replace)).await.map_err(|e| Error::invalid(e.to_string()))?
}

#[tauri::command]
pub async fn cli_uninstall() -> Result<crate::cli_install::CliStatus> {
    tauri::async_runtime::spawn_blocking(crate::cli_install::uninstall).await.map_err(|e| Error::invalid(e.to_string()))?
}

// ---- engine -------------------------------------------------------------------------------

#[tauri::command]
pub async fn engine_status(state: State<'_, AppState>) -> Result<EngineStatus> {
    Ok(state.engine.status().await)
}

#[tauri::command]
pub async fn engine_install(app: AppHandle, state: State<'_, AppState>) -> Result<EngineStatus> {
    let engine = state.engine.clone();
    engine
        .install(|line| {
            let _ = app.emit("engine://install-log", line);
        })
        .await?;
    engine.start().await?;
    Ok(engine.status().await)
}

#[tauri::command]
pub async fn engine_start(state: State<'_, AppState>) -> Result<EngineStatus> {
    state.engine.start().await?;
    Ok(state.engine.status().await)
}

#[tauri::command]
pub async fn engine_stop(state: State<'_, AppState>) -> Result<EngineStatus> {
    state.engine.stop().await?;
    Ok(state.engine.status().await)
}

// ---- models -------------------------------------------------------------------------------

#[tauri::command]
pub async fn models_installed(state: State<'_, AppState>) -> Result<Vec<LocalModel>> {
    state.client().tags().await
}

#[tauri::command]
pub fn models_catalog() -> Vec<CatalogModel> {
    CATALOG.to_vec()
}

#[derive(Clone, Serialize)]
struct PullEvent {
    model: String,
    status: String,
    completed: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Pull with progress on `model://pull`. Byte counts are summed over layers.
#[tauri::command]
pub async fn model_pull(app: AppHandle, state: State<'_, AppState>, model: String) -> Result<()> {
    let client = state.client();
    let mut layers: IndexMap<String, (u64, u64)> = IndexMap::new();
    let mut last_emit = Instant::now() - std::time::Duration::from_secs(1);
    let result = client
        .pull(&model, |p| {
            if let (Some(d), Some(t)) = (&p.digest, p.total) {
                layers.insert(d.clone(), (p.completed.unwrap_or(0), t));
            }
            if last_emit.elapsed().as_millis() < 120 && p.status.starts_with("pulling ") {
                return;
            }
            last_emit = Instant::now();
            let (completed, total) = layers.values().fold((0, 0), |a, (c, t)| (a.0 + c, a.1 + t));
            let _ = app.emit(
                "model://pull",
                PullEvent { model: model.clone(), status: p.status, completed, total, done: false, error: None },
            );
        })
        .await;
    let (completed, total) = layers.values().fold((0, 0), |a, (c, t)| (a.0 + c, a.1 + t));
    let _ = app.emit(
        "model://pull",
        PullEvent {
            model: model.clone(),
            status: if result.is_ok() { "success".into() } else { "error".into() },
            completed,
            total,
            done: true,
            error: result.as_ref().err().map(|e| e.to_string()),
        },
    );
    result
}

#[tauri::command]
pub async fn model_delete(state: State<'_, AppState>, model: String) -> Result<()> {
    state.client().delete(&model).await
}

#[tauri::command]
pub async fn presets_list(state: State<'_, AppState>) -> Result<Vec<PresetSummary>> {
    state.client().presets().await
}

/// A preset's questions, so the Playground can load them as editable questions for any model.
#[tauri::command]
pub async fn preset_show(state: State<'_, AppState>, name: String) -> Result<IndexMap<String, serde_json::Value>> {
    state.client().preset_questions(&name).await
}

/// Write a text file chosen by the user in a save dialog (Playground bulk export).
/// A text file chosen by the user (question sets to import). Up to 5 MB.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String> {
    let meta = tokio::fs::metadata(&path).await?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err(Error::invalid("the file is larger than 5 MB"));
    }
    Ok(tokio::fs::read_to_string(&path).await?)
}

#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<()> {
    tokio::fs::write(&path, contents).await?;
    Ok(())
}

// ---- quick check --------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct QuickRequest {
    model: String,
    /// Raw text, or JSON when `as_json` is set
    state: String,
    #[serde(default)]
    as_json: bool,
    /// Primitive or extended (multi / rank / number) questions; expanded here.
    #[serde(default)]
    questions: Option<IndexMap<String, AnyQuestion>>,
    #[serde(default)]
    preset: Option<String>,
}

#[derive(Serialize)]
pub struct QuickResult {
    model: String,
    answered_by: String,
    answers: IndexMap<String, AnyAnswer>,
    /// Question ids the provider declined to answer (absent from `answers`).
    refused: Vec<String>,
    routing: Option<Routing>,
    usage: Usage,
    cost_usd: f64,
    latency_ms: f64,
    load_ms: f64,
    state_truncated: bool,
    /// LLMs only: question id -> the passage of the input the answer rests on (verbatim per the model).
    quotes: IndexMap<String, String>,
}

#[tauri::command]
pub async fn quick_classify(state: State<'_, AppState>, req: QuickRequest) -> Result<QuickResult> {
    let value = if req.as_json {
        serde_json::from_str(&req.state).map_err(|e| Error::invalid(format!("input is not valid JSON: {e}")))?
    } else {
        serde_json::Value::String(req.state)
    };
    let expanded = req.questions.as_ref().map(questions::expand).transpose()?;
    let primitives = expanded.as_ref().map(|(q, _)| q.clone());
    let ctx = UsageContext::quick();
    let resp = match (req.preset.filter(|p| !p.trim().is_empty()), primitives) {
        (Some(preset), qs) => state.decider.decide_preset(&req.model, value, preset, qs, &ctx).await?,
        (None, Some(qs)) => state.decider.decide(&req.model, value, qs, &ctx).await?,
        (None, None) => return Err(Error::invalid("add a question or pick a preset")),
    };
    // A refused primitive drops the question built on it; it is reported in `refused`.
    let (answers, refused) = match &expanded {
        Some((_, plan)) => questions::assemble_except(plan, resp.answers, &resp.refused)?,
        None => (resp.answers.into_iter().map(|(k, a)| (k, a.into())).collect(), resp.refused),
    };
    // Pick-any asks one primitive per option (`{id}__multi{i}`): keep the first quote per question.
    let mut quotes = IndexMap::new();
    for (k, q) in &resp.quotes {
        let id = k.split_once("__multi").map_or(k.as_str(), |(id, _)| id);
        quotes.entry(id.to_string()).or_insert_with(|| q.clone());
    }
    Ok(QuickResult {
        quotes,
        model: req.model,
        answered_by: resp.model_answered,
        answers,
        refused,
        routing: resp.routing,
        usage: resp.usage,
        cost_usd: resp.cost_usd,
        latency_ms: resp.latency_ms,
        load_ms: resp.load_ms,
        state_truncated: resp.state_truncated,
    })
}

// ---- cloud providers ----------------------------------------------------------------------

#[tauri::command]
pub fn providers_list(state: State<'_, AppState>) -> Result<Vec<ProviderView>> {
    state.decider.providers()
}

/// Create (`id` null, custom only) or update a provider. `api_key`: null keeps the stored key,
/// `""` removes it, anything else is saved to the OS keychain.
#[tauri::command]
pub fn provider_save(state: State<'_, AppState>, input: ProviderInput) -> Result<ProviderView> {
    state.decider.save_provider(input)
}

#[tauri::command]
pub fn provider_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.decider.delete_provider(&id)
}

/// One tiny request against the provider's first enabled model; API failures come back as
/// `{ ok: false, message }`.
#[tauri::command]
pub async fn provider_test(state: State<'_, AppState>, id: String) -> Result<ProviderTest> {
    let decider = state.decider.clone();
    decider.test_provider(&id).await
}

/// The models a provider lists (`GET /v1/models`), to pick from when adding one.
#[tauri::command]
pub async fn provider_models(state: State<'_, AppState>, id: String) -> Result<Vec<classifai_core::cloud::RemoteModel>> {
    let decider = state.decider.clone();
    decider.provider_models(&id).await
}

#[tauri::command]
pub fn cloud_model_save(state: State<'_, AppState>, input: CloudModelInput) -> Result<CloudModelView> {
    state.decider.save_cloud_model(input)
}

/// `id` is `@provider/model`; built-in models cannot be deleted.
#[tauri::command]
pub fn cloud_model_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.decider.delete_cloud_model(&id)
}

/// Requests, tokens and cost per model since an RFC 3339 time (all time when null).
#[tauri::command]
pub async fn usage_summary(state: State<'_, AppState>, since: Option<String>) -> Result<Vec<UsageRow>> {
    let store = state.store.clone();
    blocking(move || store.usage_summary(since.as_deref())).await
}

// ---- datasets -----------------------------------------------------------------------------

#[tauri::command]
pub async fn dataset_import(state: State<'_, AppState>, path: String, name: Option<String>) -> Result<Dataset> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let parsed = dataset::parse_file(p)?;
        let name = name
            .filter(|n| !n.trim().is_empty())
            .or_else(|| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| "dataset".into());
        store.insert_dataset(&name, Some(&path), &parsed)
    })
    .await
    .map_err(|e| Error::invalid(e.to_string()))?
}

#[tauri::command]
pub async fn dataset_list(state: State<'_, AppState>) -> Result<Vec<Dataset>> {
    let store = state.store.clone();
    blocking(move || store.list_datasets()).await
}

#[tauri::command]
pub async fn dataset_get(state: State<'_, AppState>, id: String) -> Result<Dataset> {
    let store = state.store.clone();
    blocking(move || store.get_dataset(&id)).await
}

#[derive(Serialize)]
pub struct RowsPage {
    rows: Vec<(usize, dataset::Row)>,
    total: usize,
}

/// A page of rows. `search`: case-insensitive substring of any cell; `sort_column`: numeric-aware
/// (empty cells last). `total` is the number of matching rows.
#[tauri::command]
pub async fn dataset_rows(
    state: State<'_, AppState>,
    id: String,
    offset: usize,
    limit: usize,
    search: Option<String>,
    sort_column: Option<String>,
    sort_desc: Option<bool>,
) -> Result<RowsPage> {
    let store = state.store.clone();
    blocking(move || {
        store.get_dataset(&id)?;
        let (rows, total) = store.dataset_rows_page(
            &id,
            offset,
            limit.min(1000),
            search.as_deref(),
            sort_column.as_deref(),
            sort_desc.unwrap_or(false),
        )?;
        Ok(RowsPage { rows, total })
    })
    .await
}

/// Import pasted CSV / TSV (delimiter sniffed) or JSON / JSONL text.
#[tauri::command]
pub async fn dataset_import_text(state: State<'_, AppState>, name: String, text: String) -> Result<Dataset> {
    let store = state.store.clone();
    blocking(move || {
        let parsed = dataset::parse_text(&text)?;
        let name = Some(name.trim()).filter(|n| !n.is_empty()).unwrap_or("Pasted data");
        store.insert_dataset(name, None, &parsed)
    })
    .await
}

/// A new dataset from rows built in the app (e.g. Bulk results of pasted entries).
#[tauri::command]
pub async fn dataset_create(
    state: State<'_, AppState>,
    name: String,
    columns: Vec<String>,
    rows: Vec<dataset::Row>,
) -> Result<Dataset> {
    let store = state.store.clone();
    blocking(move || {
        if rows.is_empty() {
            return Err(Error::invalid("nothing to save: no rows"));
        }
        let name = Some(name.trim()).filter(|n| !n.is_empty()).unwrap_or("Untitled");
        store.insert_dataset(name, None, &dataset::ParsedDataset { columns, rows })
    })
    .await
}

/// A dataset that links to rows of `parent_id` and stores only the added cells:
/// `rows` are `[parent row index, { column: value }]`.
#[tauri::command]
pub async fn dataset_derive(
    state: State<'_, AppState>,
    parent_id: String,
    name: String,
    source: Option<String>,
    rows: Vec<(usize, dataset::Row)>,
) -> Result<Dataset> {
    let store = state.store.clone();
    blocking(move || {
        let name = Some(name.trim()).filter(|n| !n.is_empty()).unwrap_or("Untitled");
        store.insert_derived_dataset(&parent_id, name, source.as_deref(), &rows)
    })
    .await
}

/// Distinct values of a column: the most frequent `limit` (default 300) and the total count.
#[tauri::command]
pub async fn dataset_column_profile(state: State<'_, AppState>, id: String, column: String, limit: Option<usize>) -> Result<ColumnProfile> {
    let store = state.store.clone();
    blocking(move || store.column_profile(&id, &column, limit.unwrap_or(300))).await
}

#[tauri::command]
pub async fn dataset_value_counts(state: State<'_, AppState>, id: String, column: String) -> Result<Vec<ValueCount>> {
    let store = state.store.clone();
    blocking(move || store.value_counts(&id, &column, 300)).await
}

#[tauri::command]
pub async fn dataset_rename(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.rename_dataset(&id, &name)).await
}

#[tauri::command]
pub async fn dataset_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.delete_dataset(&id)).await
}

/// Local models currently in memory (empty when the engine is not running).
#[tauri::command]
pub async fn models_loaded(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok(state.client().loaded().await.unwrap_or_default())
}

// ---- spreadsheets and files ---------------------------------------------------------------

/// Sheets of a workbook with their first rows, to choose a sheet, header row and columns.
#[tauri::command]
pub async fn spreadsheet_inspect(path: String) -> Result<Vec<SheetPreview>> {
    blocking(move || spreadsheet::inspect(std::path::Path::new(&path))).await
}

#[tauri::command]
pub async fn spreadsheet_import(
    state: State<'_, AppState>,
    path: String,
    sheet: String,
    header_row: usize,
    columns: Vec<usize>,
    name: Option<String>,
) -> Result<Dataset> {
    let store = state.store.clone();
    blocking(move || {
        let p = std::path::Path::new(&path);
        let parsed = spreadsheet::read_sheet(p, &sheet, header_row, &columns)?;
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "workbook".into());
        let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("{stem} · {sheet}"));
        store.insert_dataset(name.trim(), Some(&format!("{path}#{sheet}")), &parsed)
    })
    .await
}

#[derive(Serialize)]
pub struct FilesImported {
    dataset: Dataset,
    skipped: Vec<documents::Skipped>,
}

/// Text, Word, PDF and image files as one dataset (one row per file). Images are copied into the
/// app's media folder (`<data dir>/media/<import id>/`).
#[tauri::command]
pub async fn files_import(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, name: Option<String>) -> Result<FilesImported> {
    let media = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::invalid(e.to_string()))?
        .join("media")
        .join(uuid::Uuid::new_v4().to_string());
    let store = state.store.clone();
    blocking(move || {
        let paths: Vec<std::path::PathBuf> = paths.iter().map(Into::into).collect();
        let r = documents::import_files(&paths, &media)?;
        let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("Files ({})", r.data.rows.len()));
        let dataset = store.insert_dataset(name.trim(), Some(&format!("{} files", r.data.rows.len() + r.skipped.len())), &r.data)?;
        Ok(FilesImported { dataset, skipped: r.skipped })
    })
    .await
}

// ---- manual labelling ---------------------------------------------------------------------

#[tauri::command]
pub async fn label_session_create(state: State<'_, AppState>, input: LabelSessionInput) -> Result<LabelSessionSummary> {
    let store = state.store.clone();
    blocking(move || store.create_label_session(&input)).await
}

#[tauri::command]
pub async fn label_sessions_list(state: State<'_, AppState>) -> Result<Vec<LabelSessionSummary>> {
    let store = state.store.clone();
    blocking(move || store.list_label_sessions()).await
}

#[tauri::command]
pub async fn label_session_get(state: State<'_, AppState>, id: String) -> Result<LabelSession> {
    let store = state.store.clone();
    blocking(move || store.get_label_session(&id)).await
}

#[tauri::command]
pub async fn label_answer_set(state: State<'_, AppState>, id: String, row_idx: usize, question_id: String, value: Option<serde_json::Value>) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.set_label_answer(&id, row_idx, &question_id, value.as_ref())).await
}

#[tauri::command]
pub async fn label_mark_set(state: State<'_, AppState>, id: String, row_idx: usize, mark: LabelMark) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.set_label_mark(&id, row_idx, &mark)).await
}

#[tauri::command]
pub async fn label_evidence_set(state: State<'_, AppState>, id: String, row_idx: usize, question_id: String, snippets: Vec<LabelSnippet>) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.set_label_evidence(&id, row_idx, &question_id, &snippets)).await
}

#[tauri::command]
pub async fn label_position_set(state: State<'_, AppState>, id: String, position: usize) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.set_label_position(&id, position)).await
}

#[tauri::command]
pub fn label_session_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    columns: Option<Vec<String>>,
    questions: Option<serde_json::Value>,
    titles: Option<IndexMap<String, String>>,
) -> Result<()> {
    let q = questions.as_ref().zip(titles.as_ref());
    state.store.update_label_session(&id, name.as_deref(), columns.as_deref(), q)
}

#[tauri::command]
pub async fn label_session_set_saved(state: State<'_, AppState>, id: String, dataset_id: Option<String>) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.set_label_session_saved(&id, dataset_id.as_deref())).await
}

#[tauri::command]
pub async fn label_session_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.delete_label_session(&id)).await
}

/// Rows at the given indices (missing ones are left out).
#[tauri::command]
pub async fn dataset_rows_at(state: State<'_, AppState>, id: String, indices: Vec<usize>) -> Result<Vec<(usize, dataset::Row)>> {
    let store = state.store.clone();
    blocking(move || Ok(indices.iter().filter_map(|&i| store.dataset_rows_by_index(&id, &[i]).ok()).flatten().collect())).await
}

// ---- Hugging Face -------------------------------------------------------------------------

/// The Hugging Face token lives in the OS keychain next to the cloud provider keys.
const HF_SECRET: &str = "huggingface";

fn hf_client() -> HfClient {
    HfClient::new(KeychainSecrets.get(HF_SECRET).ok().flatten())
}

#[tauri::command]
pub async fn hf_info(dataset: String) -> Result<HfInfo> {
    hf_client().info(&dataset).await
}

/// Import the chosen splits as one or more datasets. Progress goes to `hf://progress`.
#[tauri::command]
pub async fn hf_import(app: AppHandle, state: State<'_, AppState>, spec: HfImportSpec) -> Result<Vec<Dataset>> {
    let cancel = state.hf_cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let hf = hf_client();
    let info = hf.info(&spec.dataset).await?;
    let tables = hf
        .import(&spec, &info, |p| {
            let _ = app.emit("hf://progress", p);
        }, &cancel)
        .await?;
    let store = state.store.clone();
    blocking(move || tables.iter().map(|t| store.insert_dataset(&t.name, Some(&t.source), &t.data)).collect()).await
}

#[tauri::command]
pub fn hf_cancel(state: State<'_, AppState>) {
    state.hf_cancel.store(true, Ordering::Relaxed);
}

/// Whether a token is stored, and its last characters.
#[tauri::command]
pub fn hf_token_status() -> Result<Option<String>> {
    Ok(KeychainSecrets.get(HF_SECRET)?.map(|t| format!("…{}", &t[t.len().saturating_sub(4)..])))
}

/// Store a token; an empty one removes it.
#[tauri::command]
pub fn hf_token_set(token: String) -> Result<()> {
    match token.trim() {
        "" => KeychainSecrets.delete(HF_SECRET),
        t => KeychainSecrets.set(HF_SECRET, t),
    }
}

// ---- bulk runs ----------------------------------------------------------------------------

#[tauri::command]
pub async fn bulk_run_create(state: State<'_, AppState>, input: BulkRunInput) -> Result<BulkRunSummary> {
    let store = state.store.clone();
    blocking(move || store.create_bulk_run(&input)).await
}

#[tauri::command]
pub async fn bulk_results_put(state: State<'_, AppState>, id: String, results: Vec<BulkResult>) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.put_bulk_results(&id, &results)).await
}

#[tauri::command]
pub async fn bulk_run_finish(state: State<'_, AppState>, id: String, status: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.finish_bulk_run(&id, &status)).await
}

#[tauri::command]
pub async fn bulk_runs_list(state: State<'_, AppState>) -> Result<Vec<BulkRunSummary>> {
    let store = state.store.clone();
    blocking(move || store.list_bulk_runs()).await
}

#[tauri::command]
pub async fn bulk_run_get(state: State<'_, AppState>, id: String) -> Result<BulkRun> {
    let store = state.store.clone();
    blocking(move || store.get_bulk_run(&id)).await
}

#[tauri::command]
pub async fn bulk_run_rename(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.rename_bulk_run(&id, &name)).await
}

#[tauri::command]
pub async fn bulk_run_set_saved(state: State<'_, AppState>, id: String, dataset_id: Option<String>) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.set_bulk_run_saved(&id, dataset_id.as_deref())).await
}

#[tauri::command]
pub async fn bulk_run_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.delete_bulk_run(&id)).await
}

// ---- UI state -----------------------------------------------------------------------------

#[tauri::command]
pub async fn ui_state_get(state: State<'_, AppState>) -> Result<IndexMap<String, serde_json::Value>> {
    let store = state.store.clone();
    blocking(move || store.ui_state()).await
}

#[tauri::command]
pub async fn ui_state_set(state: State<'_, AppState>, key: String, value: Option<serde_json::Value>) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.set_ui_state(&key, value.as_ref())).await
}

// ---- experiments --------------------------------------------------------------------------

/// Save an experiment's predictions as a dataset linked to the experiment's dataset.
#[tauri::command]
pub async fn experiment_save_as_dataset(state: State<'_, AppState>, id: String, name: String) -> Result<Dataset> {
    let store = state.store.clone();
    blocking(move || {
        let name = match name.trim() {
            "" => format!("{} results", store.get_experiment(&id)?.name),
            n => n.to_string(),
        };
        store.save_experiment_as_dataset(&id, &name)
    })
    .await
}

#[tauri::command]
pub async fn experiment_create(state: State<'_, AppState>, config: ExperimentConfig) -> Result<String> {
    let store = state.store.clone();
    blocking(move || runner::create(&store, &config)).await
}

/// Start (or resume) an experiment in the background. Progress goes to `experiment://progress`.
#[tauri::command]
pub fn experiment_start(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&id) {
            return Ok(());
        }
        running.insert(id.clone(), cancel.clone());
    }
    let store = state.store.clone();
    let decider = state.decider.clone();
    tauri::async_runtime::spawn(async move {
        let emitter = app.clone();
        let result = runner::execute(store.clone(), decider, id.clone(), cancel, move |ev: RunEvent| {
            let _ = emitter.emit("experiment://progress", ev);
        })
        .await;
        if let Err(e) = result {
            let _ = store.set_experiment_status(&id, ExperimentStatus::Failed, Some(&e.to_string()));
            let _ = app.emit(
                "experiment://progress",
                RunEvent {
                    experiment_id: id.clone(),
                    model: None,
                    done: 0,
                    total: 0,
                    status: ExperimentStatus::Failed,
                    message: Some(e.to_string()),
                    loading: false,
                },
            );
        }
        app.state::<AppState>().running.lock().unwrap().remove(&id);
    });
    Ok(())
}

#[tauri::command]
pub fn experiment_cancel(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Some(flag) = state.running.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn experiment_list(state: State<'_, AppState>, dataset_id: Option<String>) -> Result<Vec<Experiment>> {
    let store = state.store.clone();
    blocking(move || store.list_experiments(dataset_id.as_deref())).await
}

#[tauri::command]
pub async fn experiment_get(state: State<'_, AppState>, id: String) -> Result<Experiment> {
    let store = state.store.clone();
    blocking(move || store.get_experiment(&id)).await
}

/// Metrics for one question (default: the first), with ground truth re-read from the dataset and
/// label corrections.
#[tauri::command]
pub async fn experiment_report(state: State<'_, AppState>, id: String, question: Option<String>) -> Result<Report> {
    let store = state.store.clone();
    blocking(move || {
        let e = store.get_experiment(&id)?;
        let task = analysis::pick_task(&e, question.as_deref())?;
        analysis::report(&store, &e, task)
    })
    .await
}

/// Rows of one question (default: the first); rows without a ground truth for it are left out.
///
/// `filter`: `all`, `wrong` (any model wrong or failed), `disagree` (models differ),
/// `wrong:<model>` (that model wrong or failed).
#[tauri::command]
pub async fn experiment_predictions(
    state: State<'_, AppState>,
    id: String,
    question: Option<String>,
    filter: String,
    offset: usize,
    limit: usize,
) -> Result<PredictionsPage> {
    let store = state.store.clone();
    blocking(move || {
        let e = store.get_experiment(&id)?;
        let task = analysis::pick_task(&e, question.as_deref())?;
        analysis::predictions_page(&store, &e, task, &filter, offset, limit.min(500))
    })
    .await
}

/// Rows worth a human look: `strategy` is `disagree`, `wrong` or `low_confidence` (any answer
/// below `confidence_below`, default 0.5). Reviewed rows last, least confident first.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn experiment_review_queue(
    state: State<'_, AppState>,
    id: String,
    question: String,
    strategy: String,
    offset: usize,
    limit: usize,
    confidence_below: Option<f64>,
) -> Result<PredictionsPage> {
    let store = state.store.clone();
    blocking(move || {
        let e = store.get_experiment(&id)?;
        let task = analysis::pick_task(&e, Some(&question))?;
        analysis::review_queue(&store, &e, task, &strategy, offset, limit.min(500), confidence_below)
    })
    .await
}

/// Rows, requests, tokens, cost and time of an experiment before it is created.
#[tauri::command]
pub async fn experiment_estimate(state: State<'_, AppState>, config: ExperimentConfig) -> Result<Estimate> {
    let store = state.store.clone();
    blocking(move || analysis::estimate(&store, &config)).await
}

/// Precision / recall / F1 / accuracy of a binary question at thresholds 0.05–0.95 for one model.
#[tauri::command]
pub async fn experiment_threshold_curve(
    state: State<'_, AppState>,
    id: String,
    question: String,
    model: String,
) -> Result<ThresholdCurve> {
    let store = state.store.clone();
    blocking(move || {
        let e = store.get_experiment(&id)?;
        analysis::threshold_curve(&store, &e, &question, &model)
    })
    .await
}

/// Store a binary question's threshold and re-decide its stored answers.
#[tauri::command]
pub async fn experiment_set_threshold(state: State<'_, AppState>, id: String, question: String, threshold: f64) -> Result<()> {
    let store = state.store.clone();
    blocking(move || analysis::set_threshold(&store, &id, &question, threshold)).await
}

/// Write a Markdown (`md`) or self-contained HTML (`html`) report; returns the path.
#[tauri::command]
pub async fn experiment_export_report(state: State<'_, AppState>, id: String, path: String, format: String) -> Result<String> {
    let store = state.store.clone();
    blocking(move || export::write_report(&store, &id, &path, export::Format::parse(&format)?)).await
}

/// Requests, tokens and cost per model of one experiment.
#[tauri::command]
pub async fn experiment_usage(state: State<'_, AppState>, id: String) -> Result<Vec<UsageRow>> {
    let store = state.store.clone();
    blocking(move || store.experiment_usage(&id)).await
}

#[tauri::command]
pub async fn experiment_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    experiment_cancel(state.clone(), id.clone())?;
    let store = state.store.clone();
    blocking(move || store.delete_experiment(&id)).await
}

/// One line per experiment row; per question `{q}:ground_truth` (with label corrections) and per
/// model `{q}:{model}:predicted|confidence|correct`.
#[tauri::command]
pub async fn experiment_export_csv(state: State<'_, AppState>, id: String, path: String) -> Result<usize> {
    let store = state.store.clone();
    blocking(move || {
        let e = store.get_experiment(&id)?;
        analysis::export_csv(&store, &e, &path)
    })
    .await
}

// ---- label corrections --------------------------------------------------------------------

/// Correct (or, with the cell's own value, confirm) the ground truth of one cell.
#[tauri::command]
pub fn label_correction_set(
    state: State<'_, AppState>,
    dataset_id: String,
    row_idx: usize,
    column: String,
    value: String,
    note: Option<String>,
) -> Result<()> {
    state.store.set_label_correction(&dataset_id, row_idx, &column, &value, note.as_deref()).map(|_| ())
}

#[tauri::command]
pub async fn label_correction_clear(state: State<'_, AppState>, dataset_id: String, row_idx: usize, column: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.clear_label_correction(&dataset_id, row_idx, &column)).await
}

#[tauri::command]
pub async fn label_corrections_list(state: State<'_, AppState>, dataset_id: String) -> Result<Vec<LabelCorrection>> {
    let store = state.store.clone();
    blocking(move || store.label_corrections(&dataset_id)).await
}

// ---- question sets ------------------------------------------------------------------------

#[tauri::command]
pub async fn question_sets_list(state: State<'_, AppState>) -> Result<Vec<QuestionSetSummary>> {
    let store = state.store.clone();
    blocking(move || store.list_question_sets()).await
}

/// One version of a set (latest when `version` is null).
#[tauri::command]
pub async fn question_set_get(state: State<'_, AppState>, id: String, version: Option<u32>) -> Result<QuestionSet> {
    let store = state.store.clone();
    blocking(move || store.get_question_set(&id, version)).await
}

/// Create a set (`id` null) or save a new version (only when the payload changed).
#[tauri::command]
pub async fn question_set_save(state: State<'_, AppState>, input: QuestionSetInput) -> Result<QuestionSetSummary> {
    let store = state.store.clone();
    blocking(move || store.save_question_set(&input)).await
}

#[tauri::command]
pub async fn question_set_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let store = state.store.clone();
    blocking(move || store.delete_question_set(&id)).await
}

// ---- settings, budget, track record -------------------------------------------------------

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings> {
    let store = state.store.clone();
    blocking(move || store.settings()).await
}

#[tauri::command]
pub async fn settings_save(state: State<'_, AppState>, input: AppSettings) -> Result<AppSettings> {
    let store = state.store.clone();
    blocking(move || store.save_settings(&input)).await
}

/// Cloud spend this calendar month (local time) against the monthly budget.
#[tauri::command]
pub async fn budget_status(state: State<'_, AppState>) -> Result<BudgetStatus> {
    let store = state.store.clone();
    blocking(move || store.budget_status()).await
}

/// Each model's best question result across completed experiments, best first.
#[tauri::command]
pub async fn models_track_record(state: State<'_, AppState>) -> Result<Vec<TrackRecord>> {
    let store = state.store.clone();
    blocking(move || analysis::track_record(&store)).await
}
