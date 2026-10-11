//! Everything computed from a stored experiment: reports (ground truth re-read from the dataset with
//! label corrections applied), the predictions table, the review queue, threshold curves, cost and
//! time estimates, and each model's track record.
//!
//! Ground truth stored on predictions is what the row said when the model was asked. Reads here
//! never trust it: they recompute it from the dataset, corrections and the task's labels/aliases,
//! so a correction made after a run changes the metrics.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde::Serialize;

use crate::dataset::Row;
use crate::eval::{self, Report};
use crate::ollaya::Question;
use crate::providers::{parse_model_id, ModelRef};
use crate::runner::{self, DEFAULT_CONCURRENCY};
use crate::store::{Corrections, Experiment, ExperimentConfig, ExperimentStatus, Prediction, Store};
use crate::task::{TaskKind, TaskSpec};
use crate::{Error, Result};

// ---- ground truth -------------------------------------------------------------------------

/// Experiment rows (corrections applied) and the corrections themselves.
fn experiment_rows(store: &Store, e: &Experiment) -> Result<(Vec<(usize, Row)>, Corrections)> {
    let corrections = store.corrections_map(&e.dataset_id)?;
    let mut rows = store.dataset_rows_by_index(&e.dataset_id, &e.row_indices)?;
    crate::store::apply_corrections(&mut rows, &corrections);
    Ok((rows, corrections))
}

/// row -> current ground truth of one question (rows whose value is not a label are absent).
fn truth_map(task: &TaskSpec, rows: &[(usize, Row)]) -> HashMap<usize, String> {
    rows.iter().filter_map(|(i, r)| Some((*i, task.ground_truth(r)?))).collect()
}

/// Predictions of one question with ground truth replaced by the current one; predictions of rows
/// that no longer have a valid ground truth are dropped.
fn rescored(store: &Store, e: &Experiment, task: &TaskSpec, truth: &HashMap<usize, String>) -> Result<Vec<Prediction>> {
    Ok(store
        .predictions_for(&e.id, &task.id)?
        .into_iter()
        .filter_map(|mut p| {
            p.ground_truth = truth.get(&p.row_idx)?.clone();
            Some(p)
        })
        .collect())
}

/// The task a command is about: `question` when given, else the experiment's first.
pub fn pick_task<'a>(e: &'a Experiment, question: Option<&str>) -> Result<&'a TaskSpec> {
    match question {
        Some(q) => e.config.task(q).ok_or_else(|| Error::NotFound(format!("question {q}"))),
        None => e.config.tasks.first().ok_or_else(|| Error::invalid("this experiment has no questions")),
    }
}

/// Metrics for one question, with ground truth from the dataset and label corrections.
pub fn report(store: &Store, e: &Experiment, task: &TaskSpec) -> Result<Report> {
    let (rows, corrections) = experiment_rows(store, e)?;
    report_with(store, e, task, &rows, &corrections)
}

fn report_with(
    store: &Store,
    e: &Experiment,
    task: &TaskSpec,
    rows: &[(usize, Row)],
    corrections: &Corrections,
) -> Result<Report> {
    let truth = truth_map(task, rows);
    let preds = rescored(store, e, task, &truth)?;
    let mut r = eval::report(&task.id, &task.label_values(), &e.config.models, &preds);
    r.reviewed_rows =
        e.row_indices.iter().filter(|i| corrections.contains_key(&(**i, task.label_column.clone()))).count();
    Ok(r)
}

/// Reports for every question of an experiment, reading the dataset once.
pub fn reports(store: &Store, e: &Experiment) -> Result<Vec<Report>> {
    let (rows, corrections) = experiment_rows(store, e)?;
    e.config.tasks.iter().map(|t| report_with(store, e, t, &rows, &corrections)).collect()
}

// ---- predictions table and review queue ---------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ModelCell {
    pub predicted: Option<String>,
    pub confidence: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PredictionRow {
    pub row_idx: usize,
    pub input: String,
    /// Current ground truth: the label after corrections and aliases (or, for a row corrected to a
    /// value that is not a label, that value).
    pub ground_truth: String,
    pub by_model: IndexMap<String, ModelCell>,
    /// A human corrected or confirmed this row's ground truth.
    pub corrected: bool,
    /// The raw cell value before the correction.
    pub original_ground_truth: Option<String>,
    pub review_note: Option<String>,
}

impl PredictionRow {
    fn min_confidence(&self) -> f64 {
        self.by_model.values().filter_map(|c| c.confidence).fold(f64::INFINITY, f64::min).clamp(0.0, 1.0)
    }
    fn answered(&self) -> impl Iterator<Item = (&str, f64)> {
        self.by_model.values().filter_map(|c| Some((c.predicted.as_deref()?, c.confidence.unwrap_or(0.0))))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PredictionsPage {
    pub rows: Vec<PredictionRow>,
    pub total: usize,
}

pub fn input_text(config: &ExperimentConfig, row: &Row) -> String {
    match config.state(row) {
        serde_json::Value::String(s) => s,
        v => v.to_string(),
    }
}

/// One question's predictions joined onto the experiment rows that have a ground truth for it (or
/// a correction of it, so reviewed rows stay visible even when corrected to a non-label).
pub fn joined_rows(store: &Store, e: &Experiment, task: &TaskSpec) -> Result<Vec<PredictionRow>> {
    let (rows, corrections) = experiment_rows(store, e)?;
    joined_with(store, e, task, &rows, &corrections)
}

fn joined_with(
    store: &Store,
    e: &Experiment,
    task: &TaskSpec,
    rows: &[(usize, Row)],
    corrections: &Corrections,
) -> Result<Vec<PredictionRow>> {
    let mut by_row: IndexMap<usize, PredictionRow> = rows
        .iter()
        .filter_map(|(idx, row)| {
            let correction = corrections.get(&(*idx, task.label_column.clone()));
            let ground_truth = task.ground_truth(row).or_else(|| correction.map(|c| c.value.clone()))?;
            let by_model = e
                .config
                .models
                .iter()
                .map(|m| (m.clone(), ModelCell { predicted: None, confidence: None, error: Some("pending".into()) }))
                .collect();
            Some((
                *idx,
                PredictionRow {
                    row_idx: *idx,
                    input: input_text(&e.config, row),
                    ground_truth,
                    by_model,
                    corrected: correction.is_some(),
                    original_ground_truth: correction.map(|c| c.original.clone()),
                    review_note: correction.and_then(|c| c.note.clone()),
                },
            ))
        })
        .collect();
    for p in store.predictions_for(&e.id, &task.id)? {
        if let Some(r) = by_row.get_mut(&p.row_idx) {
            r.by_model.insert(p.model, ModelCell { predicted: p.predicted, confidence: p.confidence, error: p.error });
        }
    }
    Ok(by_row.into_values().collect())
}

/// `filter`: `all`, `wrong` (any model wrong or failed), `disagree` (models differ),
/// `wrong:<model>` (that model wrong or failed).
pub fn predictions_page(
    store: &Store,
    e: &Experiment,
    task: &TaskSpec,
    filter: &str,
    offset: usize,
    limit: usize,
) -> Result<PredictionsPage> {
    let filtered: Vec<PredictionRow> = joined_rows(store, e, task)?
        .into_iter()
        .filter(|r| {
            let wrong = |c: &ModelCell| c.predicted.as_deref() != Some(r.ground_truth.as_str());
            match filter {
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
    Ok(PredictionsPage { rows: filtered.into_iter().skip(offset).take(limit).collect(), total })
}

pub const DEFAULT_REVIEW_CONFIDENCE: f64 = 0.5;

/// Rows worth a human look. `strategy`: `disagree` (models answered with different labels),
/// `wrong` (any model's answer differs from the ground truth), `low_confidence` (any answer below
/// `confidence_below`, default 0.5). Rows already corrected or confirmed come last; within each
/// group, least confident first.
pub fn review_queue(
    store: &Store,
    e: &Experiment,
    task: &TaskSpec,
    strategy: &str,
    offset: usize,
    limit: usize,
    confidence_below: Option<f64>,
) -> Result<PredictionsPage> {
    let below = confidence_below.unwrap_or(DEFAULT_REVIEW_CONFIDENCE);
    let keep: Box<dyn Fn(&PredictionRow) -> bool> = match strategy {
        "disagree" => Box::new(|r: &PredictionRow| {
            let mut labels = r.answered().map(|(p, _)| p);
            let first = labels.next();
            first.is_some_and(|f| labels.any(|p| p != f))
        }),
        "wrong" => Box::new(|r: &PredictionRow| r.answered().any(|(p, _)| p != r.ground_truth)),
        "low_confidence" => Box::new(move |r: &PredictionRow| r.answered().any(|(_, c)| c < below)),
        other => {
            return Err(Error::invalid(format!(
                "unknown review strategy \"{other}\"; use disagree, wrong or low_confidence"
            )))
        }
    };
    let mut rows: Vec<PredictionRow> = joined_rows(store, e, task)?.into_iter().filter(|r| keep(r)).collect();
    rows.sort_by(|a, b| {
        a.corrected
            .cmp(&b.corrected)
            .then(a.min_confidence().total_cmp(&b.min_confidence()))
            .then(a.row_idx.cmp(&b.row_idx))
    });
    let total = rows.len();
    Ok(PredictionsPage { rows: rows.into_iter().skip(offset).take(limit).collect(), total })
}

/// One line per experiment row; per question `{q}:ground_truth` and per model
/// `{q}:{model}:predicted|confidence|correct` (empty where that question has no ground truth).
/// Ground truth includes label corrections. Returns the number of rows written.
pub fn export_csv(store: &Store, e: &Experiment, path: &str) -> Result<usize> {
    let (data, corrections) = experiment_rows(store, e)?;
    let per_task: Vec<IndexMap<usize, PredictionRow>> = e
        .config
        .tasks
        .iter()
        .map(|t| Ok(joined_with(store, e, t, &data, &corrections)?.into_iter().map(|r| (r.row_idx, r)).collect()))
        .collect::<Result<_>>()?;
    let mut w = csv::Writer::from_path(path)?;
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

// ---- thresholds (binary questions) --------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ThresholdPoint {
    pub threshold: f64,
    /// Precision, recall and F1 of the positive label.
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
    pub accuracy: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThresholdCurve {
    pub points: Vec<ThresholdPoint>,
    pub current: f64,
}

fn binary_task<'a>(e: &'a Experiment, question: &str) -> Result<(&'a TaskSpec, &'a str, &'a str)> {
    let task = pick_task(e, Some(question))?;
    if task.kind != TaskKind::Binary {
        return Err(Error::invalid(format!("{question} is not a yes/no question; thresholds only apply to binary questions")));
    }
    match (task.positive_label_value(), task.negative_label_value()) {
        (Some(p), Some(n)) => Ok((task, p, n)),
        _ => Err(Error::invalid(format!("{question} has no positive label"))),
    }
}

/// Precision / recall / F1 (positive label) and accuracy at thresholds 0.05, 0.10, … 0.95, from
/// the stored P(positive) of one model's answered predictions.
pub fn threshold_curve(store: &Store, e: &Experiment, question: &str, model: &str) -> Result<ThresholdCurve> {
    let (task, pos, _) = binary_task(e, question)?;
    let (rows, _) = experiment_rows(store, e)?;
    let truth = truth_map(task, &rows);
    let scored: Vec<(f64, bool)> = rescored(store, e, task, &truth)?
        .into_iter()
        .filter(|p| p.model == model && p.error.is_none())
        .filter_map(|p| Some((*p.probabilities.as_ref()?.get(pos)?, p.ground_truth == pos)))
        .collect();
    Ok(ThresholdCurve { points: curve_points(&scored), current: task.threshold.unwrap_or(0.5) })
}

fn curve_points(scored: &[(f64, bool)]) -> Vec<ThresholdPoint> {
    (1..=19)
        .map(|k| {
            let t = k as f64 * 0.05;
            let (mut tp, mut fp, mut tn, mut fneg) = (0usize, 0usize, 0usize, 0usize);
            for &(p, actual) in scored {
                match (p >= t - 1e-12, actual) {
                    (true, true) => tp += 1,
                    (true, false) => fp += 1,
                    (false, false) => tn += 1,
                    (false, true) => fneg += 1,
                }
            }
            let div = |a: usize, b: usize| if b == 0 { 0.0 } else { a as f64 / b as f64 };
            let precision = div(tp, tp + fp);
            let recall = div(tp, tp + fneg);
            let f1 = if precision + recall > 0.0 { 2.0 * precision * recall / (precision + recall) } else { 0.0 };
            ThresholdPoint {
                threshold: (t * 100.0).round() / 100.0,
                precision,
                recall,
                f1,
                accuracy: div(tp + tn, scored.len()),
            }
        })
        .collect()
}

/// Store a new threshold for a binary question and re-decide every stored answer of it from its
/// P(positive). Confidence (|2p − 1|) and the top probability do not depend on the threshold.
pub fn set_threshold(store: &Store, id: &str, question: &str, threshold: f64) -> Result<()> {
    if !(threshold > 0.0 && threshold < 1.0) {
        return Err(Error::invalid("the threshold must be between 0 and 1"));
    }
    let mut e = store.get_experiment(id)?;
    let (pos, neg) = {
        let (_, p, n) = binary_task(&e, question)?;
        (p.to_string(), n.to_string())
    };
    if let Some(t) = e.config.tasks.iter_mut().find(|t| t.id == question) {
        t.threshold = Some(threshold);
    }
    store.update_experiment_config(id, &e.config)?;
    let updates: Vec<(String, usize, String)> = store
        .predictions_for(id, question)?
        .into_iter()
        .filter(|p| p.predicted.is_some())
        .filter_map(|p| {
            let prob = *p.probabilities.as_ref()?.get(&pos)?;
            let label = if prob >= threshold { pos.clone() } else { neg.clone() };
            Some((p.model, p.row_idx, label))
        })
        .collect();
    store.set_predicted(id, question, &updates)
}

// ---- estimate -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EstimateModel {
    pub model: String,
    pub est_input_tokens: u64,
    pub est_cost_usd: f64,
    pub est_seconds: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Estimate {
    pub rows: usize,
    /// One request per (model, row).
    pub requests: usize,
    pub per_model: Vec<EstimateModel>,
    pub total_cost_usd: f64,
    /// Wall clock; models run one after another.
    pub total_seconds: f64,
}

/// Rows measured to estimate tokens per row.
pub const ESTIMATE_SAMPLE_ROWS: usize = 50;
/// Seconds per request when a model has fewer than 5 past answers.
pub const DEFAULT_LOCAL_SECONDS: f64 = 0.25;
pub const DEFAULT_CLOUD_SECONDS: f64 = 0.6;

/// Characters of a question as sent: composed instructions plus label names and descriptions.
fn question_chars(q: &Question) -> usize {
    let n = |s: &Option<String>| s.as_deref().map_or(0, |s| s.chars().count());
    match q {
        Question::Choice { instructions, criteria } => {
            n(instructions) + criteria.iter().map(|(k, v)| k.chars().count() + n(v)).sum::<usize>()
        }
        Question::Score { instructions, criteria } => n(instructions) + criteria.iter().map(|c| c.chars().count()).sum::<usize>(),
        Question::Noul { instructions, criteria } => {
            n(instructions) + criteria.as_ref().map_or(0, |c| n(&c.when_true) + n(&c.when_false))
        }        Question::Text { instructions } => n(instructions),
    }
}

fn state_chars(v: &serde_json::Value) -> usize {
    match v {
        serde_json::Value::String(s) => s.chars().count(),
        v => v.to_string().chars().count(),
    }
}

/// ≈ 4 characters per token: (mean state chars over the sample + question chars) / 4, times rows.
pub fn estimate_tokens(sample_state_chars: &[usize], question_chars: usize, rows: usize) -> u64 {
    if sample_state_chars.is_empty() || rows == 0 {
        return 0;
    }
    let mean = sample_state_chars.iter().sum::<usize>() as f64 / sample_state_chars.len() as f64;
    ((mean + question_chars as f64) / 4.0 * rows as f64).round() as u64
}

/// Seconds per request: median of the model's past latencies when it has at least 5, else a default.
fn seconds_per_request(store: &Store, model: &str) -> Result<f64> {
    if let (Some(median), n) = store.model_latency_median(model)? {
        if n >= 5 {
            return Ok(median / 1000.0);
        }
    }
    Ok(if crate::providers::is_cloud_model(model) { DEFAULT_CLOUD_SECONDS } else { DEFAULT_LOCAL_SECONDS })
}

/// Tokens, cost and time of an experiment before creating it. Rows are planned exactly as
/// [`runner::create`] would (sample size, label corrections, aliases).
pub fn estimate(store: &Store, config: &ExperimentConfig) -> Result<Estimate> {
    let planned = runner::plan_rows(store, config)?;
    let n = planned.len();
    let sample: Vec<usize> = if n <= ESTIMATE_SAMPLE_ROWS {
        planned.clone()
    } else {
        (0..ESTIMATE_SAMPLE_ROWS).map(|k| planned[k * n / ESTIMATE_SAMPLE_ROWS]).collect()
    };
    let chars: Vec<usize> = store
        .corrected_rows(&config.dataset_id, Some(&sample))?
        .iter()
        .map(|(_, r)| state_chars(&config.state(r)))
        .collect();
    let q_chars: usize = config.questions().values().map(question_chars).sum();
    let tokens = estimate_tokens(&chars, q_chars, n);
    let concurrency = config.concurrency.unwrap_or(DEFAULT_CONCURRENCY).clamp(1, 32) as f64;

    let per_model = config
        .models
        .iter()
        .map(|m| {
            let cost = match parse_model_id(m)? {
                ModelRef::Local(_) => 0.0,
                ModelRef::Cloud { provider, model } => store
                    .get_cloud_model(provider, model)?
                    .map_or(0.0, |cm| cm.cost(crate::ollaya::Usage { input_tokens: tokens, output_tokens: 0 })),
            };
            Ok(EstimateModel {
                model: m.clone(),
                est_input_tokens: tokens,
                est_cost_usd: cost,
                est_seconds: n as f64 * seconds_per_request(store, m)? / concurrency,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Estimate {
        rows: n,
        requests: n * config.models.len(),
        total_cost_usd: per_model.iter().map(|m| m.est_cost_usd).sum(),
        total_seconds: per_model.iter().map(|m| m.est_seconds).sum(),
        per_model,
    })
}

// ---- track record -------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrackRecord {
    pub model: String,
    pub experiment_id: String,
    pub experiment_name: String,
    pub question_id: String,
    pub macro_f1: f64,
    pub accuracy: f64,
}

/// Answered rows a result needs to count toward a model's track record.
pub const TRACK_RECORD_MIN_ROWS: usize = 10;

/// Each model's best question result (highest macro F1 with at least 10 scored rows) across
/// completed experiments, best first.
pub fn track_record(store: &Store) -> Result<Vec<TrackRecord>> {
    let mut best: IndexMap<String, TrackRecord> = IndexMap::new();
    for e in store.list_experiments(None)?.into_iter().filter(|e| e.status == ExperimentStatus::Completed) {
        for r in reports(store, &e)? {
            for m in &r.models {
                if m.evaluated - m.errors < TRACK_RECORD_MIN_ROWS {
                    continue;
                }
                if best.get(&m.model).is_some_and(|b| b.macro_f1 >= m.macro_f1) {
                    continue;
                }
                best.insert(
                    m.model.clone(),
                    TrackRecord {
                        model: m.model.clone(),
                        experiment_id: e.id.clone(),
                        experiment_name: e.name.clone(),
                        question_id: r.question_id.clone(),
                        macro_f1: m.macro_f1,
                        accuracy: m.accuracy,
                    },
                );
            }
        }
    }
    let mut out: Vec<TrackRecord> = best.into_values().collect();
    out.sort_by(|a, b| b.macro_f1.total_cmp(&a.macro_f1).then_with(|| a.model.cmp(&b.model)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::parse_delimited;
    use crate::store::Prediction;
    use crate::task::LabelSpec;

    fn label(v: &str, aliases: &[&str]) -> LabelSpec {
        LabelSpec { value: v.into(), description: None, aliases: aliases.iter().map(|a| a.to_string()).collect() }
    }

    fn team() -> TaskSpec {
        TaskSpec {
            id: "team".into(),
            kind: TaskKind::Choice,
            instructions: "Which team?".into(),
            context: None,
            label_column: "label".into(),
            labels: vec![label("billing", &["Billing"]), label("technical", &[])],
            positive_label: None,
            threshold: None,
            when: None,
        }
    }

    fn spam() -> TaskSpec {
        TaskSpec {
            id: "spam".into(),
            kind: TaskKind::Binary,
            instructions: "Is it spam?".into(),
            context: None,
            label_column: "spam".into(),
            labels: vec![label("yes", &[]), label("no", &[])],
            positive_label: Some("yes".into()),
            threshold: None,
            when: None,
        }
    }

    fn choice_pred(model: &str, row: usize, gt: &str, pred: &str, conf: f64) -> Prediction {
        Prediction {
            model: model.into(),
            row_idx: row,
            question_id: "team".into(),
            ground_truth: gt.into(),
            predicted: Some(pred.into()),
            confidence: Some(conf),
            top_prob: Some(0.5 + conf / 2.0),
            probabilities: None,
            latency_ms: Some(5.0),
            error: None,
        }
    }

    fn spam_pred(model: &str, row: usize, gt: &str, p: f64) -> Prediction {
        let mut probabilities = IndexMap::new();
        probabilities.insert("yes".to_string(), p);
        probabilities.insert("no".to_string(), 1.0 - p);
        Prediction {
            model: model.into(),
            row_idx: row,
            question_id: "spam".into(),
            ground_truth: gt.into(),
            predicted: Some(if p >= 0.5 { "yes" } else { "no" }.into()),
            confidence: Some((2.0 * p - 1.0).abs()),
            top_prob: Some(p.max(1.0 - p)),
            probabilities: Some(probabilities),
            latency_ms: Some(5.0),
            error: None,
        }
    }

    /// 5 rows; `team` has ground truth on rows 0–3 (row 1 via the alias "Billing"), `spam` on all.
    fn fixture() -> (Store, Experiment) {
        let store = Store::open_in_memory().unwrap();
        let csv = "text,label,spam\na0,billing,yes\na1,Billing,no\na2,technical,yes\na3,technical,no\na4,???,no\n";
        let d = store.insert_dataset("t", None, &parse_delimited(csv, b',').unwrap()).unwrap();
        let config = ExperimentConfig {
            name: "e".into(),
            dataset_id: d.id,
            input_columns: vec!["text".into()],
            context: None,
            tasks: vec![team(), spam()],
            models: vec!["m1".into(), "m2".into()],
            sample_size: None,
            concurrency: None,
        };
        let id = runner::create(&store, &config).unwrap();
        let preds = [
            choice_pred("m1", 0, "billing", "billing", 0.9),
            choice_pred("m1", 1, "billing", "billing", 0.8),
            choice_pred("m1", 2, "technical", "billing", 0.1),
            choice_pred("m1", 3, "technical", "technical", 0.7),
            choice_pred("m2", 0, "billing", "billing", 0.6),
            choice_pred("m2", 1, "billing", "technical", 0.2),
            choice_pred("m2", 2, "technical", "technical", 0.9),
            choice_pred("m2", 3, "technical", "technical", 0.4),
            spam_pred("m1", 0, "yes", 0.9),
            spam_pred("m1", 1, "no", 0.6),
            spam_pred("m1", 2, "yes", 0.4),
            spam_pred("m1", 3, "no", 0.1),
            spam_pred("m1", 4, "no", 0.2),
        ];
        for p in &preds {
            store.insert_prediction(&id, p).unwrap();
        }
        let e = store.get_experiment(&id).unwrap();
        (store, e)
    }

    #[test]
    fn experiment_saved_as_linked_dataset() {
        let (store, e) = fixture();
        let d = store.save_experiment_as_dataset(&e.id, "e results").unwrap();
        assert_eq!(d.parent_id.as_deref(), Some(e.dataset_id.as_str()));
        assert_eq!(d.row_count, 5);
        assert_eq!(
            d.added_columns,
            [
                "team · m1", "team · m1 confidence", "team · m2", "team · m2 confidence",
                "spam · m1", "spam · m1 confidence", "spam · m2", "spam · m2 confidence",
            ]
        );
        let rows = store.dataset_rows(&d.id, 0, 10).unwrap();
        assert_eq!(rows[2].1["text"], "a2", "linked from the experiment's dataset");
        assert_eq!(rows[2].1["team · m1"], "billing");
        assert_eq!(rows[2].1["team · m1 confidence"], "0.100");
        assert_eq!(rows[4].1["team · m1"], "", "no prediction, empty cell");
        assert_eq!(rows[4].1["spam · m2"], "");
    }

    #[test]
    fn aliases_count_as_ground_truth() {
        let (store, e) = fixture();
        assert_eq!(e.row_indices, vec![0, 1, 2, 3, 4]);
        let rows = joined_rows(&store, &e, &team()).unwrap();
        assert_eq!(rows.iter().map(|r| r.row_idx).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        assert_eq!(rows[1].ground_truth, "billing", "\"Billing\" is an alias of billing");
        assert!(!rows[1].corrected && rows[1].original_ground_truth.is_none());
    }

    #[test]
    fn corrections_override_ground_truth_in_reports() {
        let (store, e) = fixture();
        let r = report(&store, &e, &team()).unwrap();
        assert_eq!((r.models[0].accuracy, r.models[1].accuracy), (0.75, 0.75));
        assert_eq!(r.reviewed_rows, 0);

        // row 2 was really billing; row 0 is confirmed as is
        store.set_label_correction(&e.dataset_id, 2, "label", " billing ", Some("refund request")).unwrap();
        let c = store.set_label_correction(&e.dataset_id, 0, "label", "billing", None).unwrap();
        assert!(c.is_confirmation());
        let r = report(&store, &e, &team()).unwrap();
        assert_eq!(r.models[0].accuracy, 1.0);
        assert_eq!(r.models[1].accuracy, 0.5);
        assert_eq!(r.reviewed_rows, 2);
        assert_eq!(r.models[0].evaluated, 4);

        // a correction to a value that is not a label drops the row from the metrics
        store.set_label_correction(&e.dataset_id, 3, "label", "unclear", None).unwrap();
        let r = report(&store, &e, &team()).unwrap();
        assert_eq!(r.models[0].evaluated, 3);
        assert_eq!(r.reviewed_rows, 3);
        // ... but it stays visible in the table, marked as corrected
        let rows = joined_rows(&store, &e, &team()).unwrap();
        let r2 = rows.iter().find(|r| r.row_idx == 2).unwrap();
        assert!(r2.corrected);
        assert_eq!(r2.ground_truth, "billing");
        assert_eq!(r2.original_ground_truth.as_deref(), Some("technical"));
        assert_eq!(r2.review_note.as_deref(), Some("refund request"));
        assert_eq!(rows.iter().find(|r| r.row_idx == 3).unwrap().ground_truth, "unclear");

        // the other question is unaffected; clearing restores the original
        assert_eq!(report(&store, &e, &spam()).unwrap().reviewed_rows, 0);
        store.clear_label_correction(&e.dataset_id, 3, "label").unwrap();
        store.clear_label_correction(&e.dataset_id, 2, "label").unwrap();
        store.clear_label_correction(&e.dataset_id, 0, "label").unwrap();
        assert_eq!(report(&store, &e, &team()).unwrap().models[1].accuracy, 0.75);

        // the CSV export uses the corrected ground truth too
        store.set_label_correction(&e.dataset_id, 2, "label", "billing", None).unwrap();
        let dir = std::env::temp_dir().join(format!("classifai-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.csv");
        assert_eq!(export_csv(&store, &e, path.to_str().unwrap()).unwrap(), 5);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.lines().nth(3).unwrap().starts_with("2,a2,billing,billing,0.1000,true"), "{text}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrections_change_planning() {
        let (store, e) = fixture();
        store.set_label_correction(&e.dataset_id, 4, "label", "Billing", None).unwrap();
        let config = ExperimentConfig { tasks: vec![team()], ..e.config.clone() };
        assert_eq!(runner::plan_rows(&store, &config).unwrap(), vec![0, 1, 2, 3, 4]);
        store.set_label_correction(&e.dataset_id, 0, "label", "", None).unwrap();
        assert_eq!(runner::plan_rows(&store, &config).unwrap(), vec![1, 2, 3, 4]);
    }

    #[test]
    fn review_queue_orders_unreviewed_least_confident_first() {
        let (store, e) = fixture();
        let ids = |p: PredictionsPage| p.rows.iter().map(|r| r.row_idx).collect::<Vec<_>>();
        let q = |s: &str, below: Option<f64>| review_queue(&store, &e, &team(), s, 0, 50, below).unwrap();
        assert_eq!(ids(q("disagree", None)), vec![2, 1], "row 2 has the lowest confidence (0.1)");
        assert_eq!(ids(q("wrong", None)), vec![2, 1]);
        assert_eq!(ids(q("low_confidence", None)), vec![2, 1, 3]);
        assert_eq!(ids(q("low_confidence", Some(0.15))), vec![2]);

        store.set_label_correction(&e.dataset_id, 2, "label", "billing", None).unwrap();
        assert_eq!(ids(q("disagree", None)), vec![1, 2], "reviewed rows go last");
        let page = review_queue(&store, &e, &team(), "disagree", 1, 1, None).unwrap();
        assert_eq!((page.total, page.rows[0].row_idx, page.rows[0].corrected), (2, 2, true));
        assert!(review_queue(&store, &e, &team(), "nope", 0, 10, None).is_err());
    }

    #[test]
    fn threshold_curve_and_set_threshold() {
        let (store, e) = fixture();
        let c = threshold_curve(&store, &e, "spam", "m1").unwrap();
        assert_eq!(c.points.len(), 19);
        assert_eq!(c.current, 0.5);
        assert_eq!(c.points[0].threshold, 0.05);
        assert_eq!(c.points[18].threshold, 0.95);
        // t = 0.5: predicted yes on rows 0 (yes) and 1 (no) → tp 1, fp 1, fn 1 (row 2), tn 2
        let p = &c.points[9];
        assert_eq!(p.threshold, 0.5);
        assert!((p.precision - 0.5).abs() < 1e-9 && (p.recall - 0.5).abs() < 1e-9 && (p.f1 - 0.5).abs() < 1e-9);
        assert!((p.accuracy - 0.6).abs() < 1e-9);
        // t = 0.35: row 2 (p 0.4) becomes positive → tp 2, fp 1, tn 2
        let p = &c.points[6];
        assert_eq!(p.threshold, 0.35);
        assert!((p.precision - 2.0 / 3.0).abs() < 1e-9 && (p.recall - 1.0).abs() < 1e-9 && (p.accuracy - 0.8).abs() < 1e-9);
        assert!(threshold_curve(&store, &e, "team", "m1").is_err(), "choice questions have no threshold");

        set_threshold(&store, &e.id, "spam", 0.35).unwrap();
        let e2 = store.get_experiment(&e.id).unwrap();
        assert_eq!(e2.config.task("spam").unwrap().threshold, Some(0.35));
        let preds = store.predictions_for(&e.id, "spam").unwrap();
        let row2 = preds.iter().find(|p| p.row_idx == 2).unwrap();
        assert_eq!(row2.predicted.as_deref(), Some("yes"));
        assert!((row2.confidence.unwrap() - 0.2).abs() < 1e-9, "confidence does not depend on the threshold");
        assert_eq!(preds.iter().find(|p| p.row_idx == 4).unwrap().predicted.as_deref(), Some("no"));
        assert_eq!(threshold_curve(&store, &e2, "spam", "m1").unwrap().current, 0.35);
        assert!((report(&store, &e2, e2.config.task("spam").unwrap()).unwrap().models[0].accuracy - 0.8).abs() < 1e-9);

        assert!(set_threshold(&store, &e.id, "team", 0.4).is_err());
        assert!(set_threshold(&store, &e.id, "spam", 1.0).is_err());
    }

    #[test]
    fn token_math() {
        // mean state 20 chars + 20 question chars = 40 chars ≈ 10 tokens per row
        assert_eq!(estimate_tokens(&[10, 30], 20, 3), 30);
        assert_eq!(estimate_tokens(&[], 20, 3), 0);
        assert_eq!(estimate_tokens(&[1], 0, 2), 1, "0.25 tokens per row, rounded at the end");
    }

    #[test]
    fn estimate_plans_like_create() {
        let store = Store::open_in_memory().unwrap();
        let d = store
            .insert_dataset("t", None, &parse_delimited("text,label\naaaa,x\naaaaaaaa,y\nzz,?\n", b',').unwrap())
            .unwrap();
        let task = TaskSpec {
            id: "q".into(),
            kind: TaskKind::Choice,
            instructions: "abcd".into(),
            context: None,
            label_column: "label".into(),
            labels: vec![label("x", &[]), label("y", &[])],
            positive_label: None,
            threshold: None,
            when: None,
        };
        let mut config = ExperimentConfig {
            name: "e".into(),
            dataset_id: d.id.clone(),
            input_columns: vec!["text".into()],
            context: None,
            tasks: vec![task],
            models: vec!["laya".into(), "@typesafe/jev-latest".into()],
            sample_size: None,
            concurrency: None,
        };
        // 2 eligible rows, states of 4 and 8 chars (mean 6) + "abcd" + "x" + "y" (6) → 3 tokens per row
        let est = estimate(&store, &config).unwrap();
        assert_eq!((est.rows, est.requests), (2, 4));
        assert_eq!(est.per_model[0].est_input_tokens, 6);
        assert_eq!(est.per_model[0].est_cost_usd, 0.0);
        assert!((est.per_model[1].est_cost_usd - 6.0 * 0.042 / 1e6).abs() < 1e-15);
        assert!((est.per_model[0].est_seconds - 2.0 * 0.25 / 4.0).abs() < 1e-9);
        assert!((est.per_model[1].est_seconds - 2.0 * 0.6 / 4.0).abs() < 1e-9);
        assert!((est.total_seconds - 0.425).abs() < 1e-9);
        assert_eq!(est.total_cost_usd, est.per_model[1].est_cost_usd);

        // with at least 5 past answers, the model's median latency is used
        let id = runner::create(&store, &config).unwrap();
        for (i, ms) in [100.0, 500.0, 300.0, 200.0, 400.0].into_iter().enumerate() {
            let mut p = choice_pred("laya", i, "x", "x", 0.5);
            p.question_id = "q".into();
            p.latency_ms = Some(ms);
            store.insert_prediction(&id, &p).unwrap();
        }
        config.concurrency = Some(2);
        config.sample_size = Some(1);
        let est = estimate(&store, &config).unwrap();
        assert_eq!(est.rows, 1);
        assert!((est.per_model[0].est_seconds - 0.3 / 2.0).abs() < 1e-9);

        config.models.clear();
        assert!(estimate(&store, &config).is_err(), "validated like create");
    }

    #[test]
    fn track_record_keeps_each_models_best() {
        let store = Store::open_in_memory().unwrap();
        let mut csv = String::from("text,label\n");
        for i in 0..12 {
            csv.push_str(&format!("t{i},{}\n", if i % 2 == 0 { "x" } else { "y" }));
        }
        let d = store.insert_dataset("t", None, &parse_delimited(&csv, b',').unwrap()).unwrap();
        let task = TaskSpec { id: "q".into(), label_column: "label".into(), labels: vec![label("x", &[]), label("y", &[])], ..team() };
        let config = ExperimentConfig {
            name: "first".into(),
            dataset_id: d.id,
            input_columns: vec!["text".into()],
            context: None,
            tasks: vec![task],
            models: vec!["good".into(), "few".into()],
            sample_size: None,
            concurrency: None,
        };
        let run = |name: &str, wrong: usize| {
            let id = runner::create(&store, &ExperimentConfig { name: name.into(), ..config.clone() }).unwrap();
            for i in 0..12 {
                let gt = if i % 2 == 0 { "x" } else { "y" };
                let pred = if i < wrong { if gt == "x" { "y" } else { "x" } } else { gt };
                let mut p = choice_pred("good", i, gt, pred, 0.5);
                p.question_id = "q".into();
                store.insert_prediction(&id, &p).unwrap();
                if i < 3 {
                    store.insert_prediction(&id, &Prediction { model: "few".into(), ..p }).unwrap();
                }
            }
            store.set_experiment_status(&id, ExperimentStatus::Completed, None).unwrap();
            id
        };
        run("worse", 4);
        let best = run("better", 0);
        let pending = runner::create(&store, &ExperimentConfig { name: "pending".into(), ..config.clone() }).unwrap();
        let tr = track_record(&store).unwrap();
        assert_eq!(tr.len(), 1, "\"few\" has fewer than 10 scored rows");
        assert_eq!((tr[0].model.as_str(), tr[0].experiment_id.as_str()), ("good", best.as_str()));
        assert_eq!((tr[0].experiment_name.as_str(), tr[0].question_id.as_str(), tr[0].macro_f1), ("better", "q", 1.0));
        assert_ne!(tr[0].experiment_id, pending);
    }
}
