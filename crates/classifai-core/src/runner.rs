//! Run an experiment: every selected row through every selected model (local or cloud, via the
//! [`Decider`]), all questions of a row in one request. Usage is logged against the experiment.
//!
//! Predictions (one per question with a ground truth on that row) are written as they arrive, so a
//! cancelled or interrupted experiment keeps what it has and can be resumed (rows that already have
//! a prediction for that model are skipped).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{stream, StreamExt};
use serde::Serialize;

use crate::dataset::Row;
use crate::decider::{Decider, UsageContext};
use crate::ollaya::Question;
use crate::store::{ExperimentConfig, ExperimentStatus, Prediction, Store};
use crate::{Error, Result};

pub const DEFAULT_CONCURRENCY: usize = 4;

/// Seed of the deterministic row sample (Fisher–Yates with xorshift64).
pub const SAMPLE_SEED: u64 = 0x5EED_C1A5;

#[derive(Debug, Clone, Serialize)]
pub struct RunEvent {
    pub experiment_id: String,
    pub model: Option<String>,
    pub done: usize,
    pub total: usize,
    pub status: ExperimentStatus,
    pub message: Option<String>,
}

/// Rows where at least one question's ground truth (after label corrections and aliases) is one of
/// its labels, sampled deterministically.
pub fn plan_rows(store: &Store, config: &ExperimentConfig) -> Result<Vec<usize>> {
    config.validate()?;
    let rows = store.corrected_rows(&config.dataset_id, None)?;
    let mut eligible: Vec<usize> = rows
        .iter()
        .filter(|(_, r)| config.has_ground_truth(r))
        .map(|(i, _)| *i)
        .collect();
    if eligible.is_empty() {
        return Err(Error::invalid("no rows have a ground-truth value matching the chosen labels"));
    }
    if let Some(n) = config.sample_size.filter(|&n| n > 0 && n < eligible.len()) {
        shuffle(&mut eligible, SAMPLE_SEED);
        eligible.truncate(n);
        eligible.sort_unstable();
    }
    Ok(eligible)
}

pub fn create(store: &Store, config: &ExperimentConfig) -> Result<String> {
    let rows = plan_rows(store, config)?;
    store.create_experiment(config, &rows)
}

pub async fn execute(
    store: Arc<Store>,
    decider: Arc<Decider>,
    experiment_id: String,
    cancel: Arc<AtomicBool>,
    on_event: impl Fn(RunEvent) + Send + Sync,
) -> Result<ExperimentStatus> {
    let exp = store.get_experiment(&experiment_id)?;
    let config = Arc::new(exp.config.clone());
    let questions = config.questions();
    let total = exp.row_indices.len();
    let concurrency = exp.config.concurrency.unwrap_or(DEFAULT_CONCURRENCY).clamp(1, 32);
    let rows = store.corrected_rows(&exp.dataset_id, Some(&exp.row_indices))?;
    let existing: HashSet<(String, usize)> =
        store.predictions(&experiment_id)?.into_iter().map(|p| (p.model, p.row_idx)).collect();

    store.set_experiment_status(&experiment_id, ExperimentStatus::Running, None)?;
    let emit = |model: Option<&str>, done: usize, status: ExperimentStatus, message: Option<String>| {
        on_event(RunEvent {
            experiment_id: experiment_id.clone(),
            model: model.map(Into::into),
            done,
            total,
            status,
            message,
        })
    };

    for model in &exp.config.models {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let mut done = existing.iter().filter(|(m, _)| m == model).count();
        if done >= total {
            continue;
        }
        emit(Some(model), done, ExperimentStatus::Running, Some(format!("Loading {model}…")));
        // For a cloud model this also checks the monthly budget (hard stop): when it is used up,
        // the model's remaining rows get that error without a single request.
        if let Err(e) = decider.load(model).await {
            let msg = match e.code() {
                "BUDGET_EXCEEDED" => e.to_string(),
                _ => format!("{model} could not be loaded: {e}"),
            };
            for (idx, row) in &rows {
                if existing.contains(&(model.clone(), *idx)) {
                    continue;
                }
                for p in error_predictions(model, *idx, &config, row, &msg) {
                    store.insert_prediction(&experiment_id, &p)?;
                }
            }
            emit(Some(model), total, ExperimentStatus::Running, Some(msg));
            continue;
        }
        emit(Some(model), done, ExperimentStatus::Running, None);

        // Each future owns its inputs so the whole run is `Send + 'static` (spawnable).
        let pending: Vec<(usize, Row)> =
            rows.iter().filter(|(i, _)| !existing.contains(&(model.clone(), *i))).cloned().collect();
        let mut results = stream::iter(pending)
            .map(|(idx, row)| {
                let decider = decider.clone();
                let ctx = UsageContext::experiment(experiment_id.clone());
                let questions = questions.clone();
                let config = config.clone();
                let model = model.clone();
                let cancel = cancel.clone();
                async move {
                    if cancel.load(Ordering::Relaxed) {
                        return None;
                    }
                    Some(predict(&decider, &ctx, &model, &config, questions, idx, &row).await)
                }
            })
            .buffer_unordered(concurrency);

        while let Some(ps) = results.next().await {
            let Some(ps) = ps else { continue };
            for p in &ps {
                store.insert_prediction(&experiment_id, p)?;
            }
            done += 1;
            emit(Some(model), done, ExperimentStatus::Running, None);
        }
    }

    let status = if cancel.load(Ordering::Relaxed) { ExperimentStatus::Cancelled } else { ExperimentStatus::Completed };
    store.set_experiment_status(&experiment_id, status, None)?;
    emit(None, total, status, None);
    Ok(status)
}

/// One request for all questions; one prediction per question with a ground truth on this row.
async fn predict(
    decider: &Decider,
    ctx: &UsageContext,
    model: &str,
    config: &ExperimentConfig,
    questions: indexmap::IndexMap<String, Question>,
    idx: usize,
    row: &Row,
) -> Vec<Prediction> {
    let resp = match decider.decide(model, config.state(row), questions, ctx).await {
        Ok(resp) => resp,
        Err(e) => return error_predictions(model, idx, config, row, &e.to_string()),
    };
    // Latency is per request, so every question of the row shares it.
    let latency = resp.latency_ms;
    config
        .tasks
        .iter()
        .filter_map(|task| {
            let gt = task.ground_truth(row)?;
            let base = Prediction {
                model: model.to_string(),
                row_idx: idx,
                question_id: task.id.clone(),
                ground_truth: gt,
                predicted: None,
                confidence: None,
                top_prob: None,
                probabilities: None,
                latency_ms: None,
                error: None,
            };
            Some(match resp.answers.get(&task.id).map(|a| task.interpret(a)) {
                Some(Ok(i)) => Prediction {
                    predicted: Some(i.predicted),
                    confidence: Some(i.confidence),
                    top_prob: Some(i.top_prob),
                    probabilities: Some(i.probabilities),
                    latency_ms: Some(latency),
                    ..base
                },
                Some(Err(e)) => Prediction { error: Some(e.to_string()), ..base },
                None if resp.refused.contains(&task.id) => Prediction { error: Some("model refused this question".into()), ..base },
                None => Prediction { error: Some("answer missing from response".into()), ..base },
            })
        })
        .collect()
}

/// The same failure for every question with a ground truth on this row.
fn error_predictions(model: &str, idx: usize, config: &ExperimentConfig, row: &Row, msg: &str) -> Vec<Prediction> {
    config
        .tasks
        .iter()
        .filter_map(|task| {
            Some(Prediction {
                model: model.to_string(),
                row_idx: idx,
                question_id: task.id.clone(),
                ground_truth: task.ground_truth(row)?,
                predicted: None,
                confidence: None,
                top_prob: None,
                probabilities: None,
                latency_ms: None,
                error: Some(msg.to_string()),
            })
        })
        .collect()
}

/// Fisher–Yates with xorshift64: stable across platforms and releases.
fn shuffle<T>(v: &mut [T], seed: u64) {
    let mut s = seed.max(1);
    for i in (1..v.len()).rev() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        v.swap(i, (s % (i as u64 + 1)) as usize);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::parse_delimited;
    use crate::task::{LabelSpec, TaskKind, TaskSpec};

    fn choice(id: &str, column: &str, labels: &[&str]) -> TaskSpec {
        TaskSpec {
            id: id.into(),
            kind: TaskKind::Choice,
            instructions: "?".into(),
            context: None,
            label_column: column.into(),
            labels: labels.iter().map(|v| LabelSpec { value: v.to_string(), description: None, aliases: vec![] }).collect(),
            positive_label: None,
            threshold: None,
        }
    }

    fn config(dataset_id: String, tasks: Vec<TaskSpec>) -> ExperimentConfig {
        ExperimentConfig {
            name: "e".into(),
            dataset_id,
            input_columns: vec!["text".into()],
            context: None,
            tasks,
            models: vec!["laya".into()],
            sample_size: None,
            concurrency: None,
        }
    }

    #[test]
    fn plan_filters_unknown_labels_and_samples() {
        let store = Store::open_in_memory().unwrap();
        let mut csv = String::from("text,label\n");
        for i in 0..50 {
            csv.push_str(&format!("t{i},{}\n", ["a", "b", "?"][i % 3]));
        }
        let d = store.insert_dataset("x", None, &parse_delimited(&csv, b',').unwrap()).unwrap();
        let mut cfg = config(d.id, vec![choice("label", "label", &["a", "b"])]);
        let all = plan_rows(&store, &cfg).unwrap();
        assert_eq!(all.len(), 34);
        cfg.sample_size = Some(10);
        let s1 = plan_rows(&store, &cfg).unwrap();
        assert_eq!(s1.len(), 10);
        assert_eq!(s1, plan_rows(&store, &cfg).unwrap(), "sampling is deterministic");
        assert!(s1.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn plan_keeps_rows_with_any_ground_truth() {
        let store = Store::open_in_memory().unwrap();
        let csv = "text,team,urgent\n\
            r0,billing,yes\n\
            r1,billing,\n\
            r2,,no\n\
            r3,??,maybe\n\
            r4,account,no\n";
        let d = store.insert_dataset("x", None, &parse_delimited(csv, b',').unwrap()).unwrap();
        let team = choice("team", "team", &["billing", "account"]);
        let urgent = choice("urgent", "urgent", &["yes", "no"]);
        assert_eq!(plan_rows(&store, &config(d.id.clone(), vec![team.clone()])).unwrap(), vec![0, 1, 4]);
        assert_eq!(plan_rows(&store, &config(d.id.clone(), vec![urgent.clone()])).unwrap(), vec![0, 2, 4]);
        assert_eq!(plan_rows(&store, &config(d.id.clone(), vec![team.clone(), urgent.clone()])).unwrap(), vec![0, 1, 2, 4]);

        let mut bad = config(d.id, vec![team, urgent]);
        bad.input_columns = vec!["text".into(), "urgent".into()];
        assert!(plan_rows(&store, &bad).is_err(), "a ground-truth column cannot be an input");
    }
}
