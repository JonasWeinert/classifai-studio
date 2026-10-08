//! Tauri commands: a thin layer over `classifai-core`. Errors serialize as `{ code, message }`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use classifai_core::catalog::{CatalogModel, CATALOG};
use classifai_core::dataset;
use classifai_core::engine::EngineStatus;
use classifai_core::eval::{self, Report};
use classifai_core::ollaya::{Answer, DecideRequest, LocalModel, PresetSummary, Question, Routing};
use classifai_core::runner::{self, RunEvent};
use classifai_core::store::{Dataset, Experiment, ExperimentConfig, ExperimentStatus, ValueCount};
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
    #[serde(default)]
    questions: Option<IndexMap<String, Question>>,
    #[serde(default)]
    preset: Option<String>,
}

#[derive(Serialize)]
pub struct QuickResult {
    model: String,
    answered_by: String,
    answers: IndexMap<String, Answer>,
    routing: Option<Routing>,
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
    let started = Instant::now();
    let resp = state
        .client()
        .decide(&DecideRequest {
            model: req.model.clone(),
            state: Some(value),
            questions: req.questions,
            preset: req.preset,
            keep_alive: None,
        })
        .await?;
    let wall = started.elapsed().as_secs_f64() * 1000.0;
    Ok(QuickResult {
        model: req.model,
        answered_by: resp.model,
        answers: resp.answers,
        routing: resp.routing,
        latency_ms: if resp.eval_duration > 0 { resp.eval_duration as f64 / 1e6 } else { wall },
        load_ms: resp.load_duration as f64 / 1e6,
        state_truncated: resp.state_truncated,
    })
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
    let client = state.client();
    tauri::async_runtime::spawn(async move {
        let emitter = app.clone();
        let result = runner::execute(store.clone(), client, id.clone(), cancel, move |ev: RunEvent| {
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

#[tauri::command]
pub fn experiment_report(state: State<'_, AppState>, id: String) -> Result<Report> {
    let e = state.store.get_experiment(&id)?;
    let preds = state.store.predictions(&id)?;
    Ok(eval::report(&e.config.task.label_values(), &e.config.models, &preds))
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

/// `filter`: `all`, `wrong` (any model wrong or failed), `disagree` (models differ),
/// `wrong:<model>` (that model wrong or failed).
#[tauri::command]
pub fn experiment_predictions(
    state: State<'_, AppState>,
    id: String,
    filter: String,
    offset: usize,
    limit: usize,
) -> Result<PredictionsPage> {
    let rows = joined_rows(&state, &id)?;
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

fn joined_rows(state: &AppState, id: &str) -> Result<Vec<PredictionRow>> {
    let e = state.store.get_experiment(id)?;
    let data = state.store.dataset_rows_by_index(&e.dataset_id, &e.row_indices)?;
    let mut by_row: IndexMap<usize, PredictionRow> = data
        .into_iter()
        .map(|(idx, row)| {
            let input = match e.config.task.state(&row) {
                serde_json::Value::String(s) => s,
                v => v.to_string(),
            };
            let by_model = e
                .config
                .models
                .iter()
                .map(|m| (m.clone(), ModelCell { predicted: None, confidence: None, error: Some("pending".into()) }))
                .collect();
            let gt = e.config.task.ground_truth(&row).unwrap_or_default();
            (idx, PredictionRow { row_idx: idx, input, ground_truth: gt, by_model })
        })
        .collect();
    for p in state.store.predictions(id)? {
        if let Some(r) = by_row.get_mut(&p.row_idx) {
            r.by_model.insert(p.model, ModelCell { predicted: p.predicted, confidence: p.confidence, error: p.error });
        }
    }
    Ok(by_row.into_values().collect())
}

#[tauri::command]
pub fn experiment_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    experiment_cancel(state.clone(), id.clone())?;
    state.store.delete_experiment(&id)
}

#[tauri::command]
pub fn experiment_export_csv(state: State<'_, AppState>, id: String, path: String) -> Result<usize> {
    let e = state.store.get_experiment(&id)?;
    let rows = joined_rows(&state, &id)?;
    let mut w = csv::Writer::from_path(&path)?;
    let mut header = vec!["row".to_string(), "input".into(), "ground_truth".into()];
    for m in &e.config.models {
        header.push(format!("{m}:predicted"));
        header.push(format!("{m}:confidence"));
        header.push(format!("{m}:correct"));
    }
    w.write_record(&header)?;
    for r in &rows {
        let mut rec = vec![r.row_idx.to_string(), r.input.clone(), r.ground_truth.clone()];
        for m in &e.config.models {
            let c = &r.by_model[m];
            rec.push(c.predicted.clone().unwrap_or_default());
            rec.push(c.confidence.map(|v| format!("{v:.4}")).unwrap_or_default());
            rec.push(match &c.predicted {
                Some(p) => (p == &r.ground_truth).to_string(),
                None => String::new(),
            });
        }
        w.write_record(&rec)?;
    }
    w.flush()?;
    Ok(rows.len())
}
