//! Tauri commands: a thin layer over `classifai-core`. Errors serialize as `{ code, message }`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use classifai_core::catalog::{CatalogModel, CATALOG};
use classifai_core::dataset;
use classifai_core::decider::{ProviderTest, UsageContext};
use classifai_core::engine::EngineStatus;
use classifai_core::eval::{self, Report};
use classifai_core::ollaya::{LocalModel, PresetSummary, Routing, Usage};
use classifai_core::providers::{CloudModelInput, CloudModelView, ProviderInput, ProviderView};
use classifai_core::questions::{self, AnyAnswer, AnyQuestion};
use classifai_core::runner::{self, RunEvent};
use classifai_core::store::{Dataset, Experiment, ExperimentConfig, ExperimentStatus, UsageRow, ValueCount};
use classifai_core::task::TaskSpec;
use classifai_core::{Error, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

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
    Ok(QuickResult {
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
pub fn usage_summary(state: State<'_, AppState>, since: Option<String>) -> Result<Vec<UsageRow>> {
    state.store.usage_summary(since.as_deref())
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
pub fn dataset_list(state: State<'_, AppState>) -> Result<Vec<Dataset>> {
    state.store.list_datasets()
}

#[tauri::command]
pub fn dataset_get(state: State<'_, AppState>, id: String) -> Result<Dataset> {
    state.store.get_dataset(&id)
}

#[derive(Serialize)]
pub struct RowsPage {
    rows: Vec<(usize, dataset::Row)>,
    total: usize,
}

#[tauri::command]
pub fn dataset_rows(state: State<'_, AppState>, id: String, offset: usize, limit: usize) -> Result<RowsPage> {
    let d = state.store.get_dataset(&id)?;
    Ok(RowsPage { rows: state.store.dataset_rows(&id, offset, limit.min(1000))?, total: d.row_count })
}

#[tauri::command]
pub fn dataset_value_counts(state: State<'_, AppState>, id: String, column: String) -> Result<Vec<ValueCount>> {
    state.store.value_counts(&id, &column, 300)
}

#[tauri::command]
pub fn dataset_rename(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    state.store.rename_dataset(&id, &name)
}

#[tauri::command]
pub fn dataset_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete_dataset(&id)
}

// ---- experiments --------------------------------------------------------------------------

#[tauri::command]
pub fn experiment_create(state: State<'_, AppState>, config: ExperimentConfig) -> Result<String> {
    runner::create(&state.store, &config)
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
pub fn experiment_list(state: State<'_, AppState>, dataset_id: Option<String>) -> Result<Vec<Experiment>> {
    state.store.list_experiments(dataset_id.as_deref())
}

#[tauri::command]
pub fn experiment_get(state: State<'_, AppState>, id: String) -> Result<Experiment> {
    state.store.get_experiment(&id)
}

/// The task a command is about: `question` when given, else the experiment's first.
fn pick_task<'a>(e: &'a Experiment, question: Option<&str>) -> Result<&'a TaskSpec> {
    match question {
        Some(q) => e.config.task(q).ok_or_else(|| Error::NotFound(format!("question {q}"))),
        None => e.config.tasks.first().ok_or_else(|| Error::invalid("this experiment has no questions")),
    }
}

/// Metrics for one question (default: the first).
#[tauri::command]
pub fn experiment_report(state: State<'_, AppState>, id: String, question: Option<String>) -> Result<Report> {
    let e = state.store.get_experiment(&id)?;
    let task = pick_task(&e, question.as_deref())?;
    let preds = state.store.predictions_for(&id, &task.id)?;
    Ok(eval::report(&task.id, &task.label_values(), &e.config.models, &preds))
}

#[derive(Serialize)]
pub struct ModelCell {
    predicted: Option<String>,
    confidence: Option<f64>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct PredictionRow {
    row_idx: usize,
    input: String,
    ground_truth: String,
    by_model: IndexMap<String, ModelCell>,
}

#[derive(Serialize)]
pub struct PredictionsPage {
    rows: Vec<PredictionRow>,
    total: usize,
}

/// Rows of one question (default: the first); rows without a ground truth for it are left out.
///
/// `filter`: `all`, `wrong` (any model wrong or failed), `disagree` (models differ),
/// `wrong:<model>` (that model wrong or failed).
#[tauri::command]
pub fn experiment_predictions(
    state: State<'_, AppState>,
    id: String,
    question: Option<String>,
    filter: String,
    offset: usize,
    limit: usize,
) -> Result<PredictionsPage> {
    let e = state.store.get_experiment(&id)?;
    let task = pick_task(&e, question.as_deref())?;
    let data = state.store.dataset_rows_by_index(&e.dataset_id, &e.row_indices)?;
    let rows = joined_rows(&state, &e, task, &data)?;
    let filtered: Vec<PredictionRow> = rows
        .into_iter()
        .filter(|r| {
            let wrong = |c: &ModelCell| c.predicted.as_deref() != Some(r.ground_truth.as_str());
            match filter.as_str() {
                "wrong" => r.by_model.values().any(wrong),
                "disagree" => {
                    let mut preds = r.by_model.values().map(|c| c.predicted.as_deref());
                    let first = preds.next();
                    preds.any(|p| p != first.flatten())
                }
                f if f.starts_with("wrong:") => r.by_model.get(&f[6..]).map(wrong).unwrap_or(false),
                _ => true,
            }
        })
        .collect();
    let total = filtered.len();
    Ok(PredictionsPage { rows: filtered.into_iter().skip(offset).take(limit.min(500)).collect(), total })
}

/// One question's predictions joined onto the experiment rows that have a ground truth for it.
fn joined_rows(
    state: &AppState,
    e: &Experiment,
    task: &TaskSpec,
    data: &[(usize, dataset::Row)],
) -> Result<Vec<PredictionRow>> {
    let mut by_row: IndexMap<usize, PredictionRow> = data
        .iter()
        .filter_map(|(idx, row)| {
            let ground_truth = task.ground_truth(row)?;
            let by_model = e
                .config
                .models
                .iter()
                .map(|m| (m.clone(), ModelCell { predicted: None, confidence: None, error: Some("pending".into()) }))
                .collect();
            Some((*idx, PredictionRow { row_idx: *idx, input: input_text(&e.config, row), ground_truth, by_model }))
        })
        .collect();
    for p in state.store.predictions_for(&e.id, &task.id)? {
        if let Some(r) = by_row.get_mut(&p.row_idx) {
            r.by_model.insert(p.model, ModelCell { predicted: p.predicted, confidence: p.confidence, error: p.error });
        }
    }
    Ok(by_row.into_values().collect())
}

fn input_text(config: &ExperimentConfig, row: &dataset::Row) -> String {
    match config.state(row) {
        serde_json::Value::String(s) => s,
        v => v.to_string(),
    }
}

/// Requests, tokens and cost per model of one experiment.
#[tauri::command]
pub fn experiment_usage(state: State<'_, AppState>, id: String) -> Result<Vec<UsageRow>> {
    state.store.experiment_usage(&id)
}

#[tauri::command]
pub fn experiment_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    experiment_cancel(state.clone(), id.clone())?;
    state.store.delete_experiment(&id)
}

/// One line per experiment row; per question `{q}:ground_truth` and per model
/// `{q}:{model}:predicted|confidence|correct` (empty where that question has no ground truth).
#[tauri::command]
pub fn experiment_export_csv(state: State<'_, AppState>, id: String, path: String) -> Result<usize> {
    let e = state.store.get_experiment(&id)?;
    let data = state.store.dataset_rows_by_index(&e.dataset_id, &e.row_indices)?;
    let per_task: Vec<IndexMap<usize, PredictionRow>> = e
        .config
        .tasks
        .iter()
        .map(|t| Ok(joined_rows(&state, &e, t, &data)?.into_iter().map(|r| (r.row_idx, r)).collect()))
        .collect::<Result<_>>()?;
    let mut w = csv::Writer::from_path(&path)?;
    let mut header = vec!["row".to_string(), "input".into()];
    for t in &e.config.tasks {
        header.push(format!("{}:ground_truth", t.id));
        for m in &e.config.models {
            header.push(format!("{}:{m}:predicted", t.id));
            header.push(format!("{}:{m}:confidence", t.id));
            header.push(format!("{}:{m}:correct", t.id));
        }
    }
    w.write_record(&header)?;
    for (idx, row) in &data {
        let mut rec = vec![idx.to_string(), input_text(&e.config, row)];
        for rows in &per_task {
            let r = rows.get(idx);
            rec.push(r.map(|r| r.ground_truth.clone()).unwrap_or_default());
            for m in &e.config.models {
                let Some((r, c)) = r.and_then(|r| Some((r, r.by_model.get(m)?))) else {
                    rec.extend([String::new(), String::new(), String::new()]);
                    continue;
                };
                rec.push(c.predicted.clone().unwrap_or_default());
                rec.push(c.confidence.map(|v| format!("{v:.4}")).unwrap_or_default());
                rec.push(match &c.predicted {
                    Some(p) => (p == &r.ground_truth).to_string(),
                    None => String::new(),
                });
            }
        }
        w.write_record(&rec)?;
    }
    w.flush()?;
    Ok(data.len())
}
