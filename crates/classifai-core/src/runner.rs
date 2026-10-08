//! Run an experiment: every selected row through every selected model.
//!
//! Predictions are written as they arrive, so a cancelled or interrupted experiment keeps what it
//! has and can be resumed (rows that already have a prediction are skipped).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::{stream, StreamExt};
use serde::Serialize;

use crate::dataset::Row;
use crate::ollaya::{Client, DecideRequest, Question};
use crate::store::{ExperimentConfig, ExperimentStatus, Prediction, Store};
use crate::task::{TaskSpec, QUESTION_ID};
use crate::{Error, Result};

pub const DEFAULT_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Serialize)]
pub struct RunEvent {
    pub experiment_id: String,
    pub model: Option<String>,
    pub done: usize,
    pub total: usize,
    pub status: ExperimentStatus,
    pub message: Option<String>,
}

/// Rows whose ground truth is one of the task's labels, sampled deterministically.
pub fn plan_rows(store: &Store, config: &ExperimentConfig) -> Result<Vec<usize>> {
    config.task.validate()?;
    if config.models.is_empty() {
        return Err(Error::invalid("pick at least one model"));
    }
    let rows = store.dataset_rows(&config.dataset_id, 0, i64::MAX as usize)?;
    let mut eligible: Vec<usize> = rows
        .iter()
        .filter(|(_, r)| config.task.ground_truth(r).is_some())
        .map(|(i, _)| *i)
        .collect();
    if eligible.is_empty() {
        return Err(Error::invalid("no rows have a ground-truth value matching the chosen labels"));
    }
    if let Some(n) = config.sample_size.filter(|&n| n > 0 && n < eligible.len()) {
        shuffle(&mut eligible, 0x5EED_C1A5);
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
    client: Client,
    experiment_id: String,
    cancel: Arc<AtomicBool>,
    on_event: impl Fn(RunEvent) + Send + Sync,
) -> Result<ExperimentStatus> {
    let exp = store.get_experiment(&experiment_id)?;
    let task = Arc::new(exp.config.task.clone());
    let questions = task.questions();
    let total = exp.row_indices.len();
    let concurrency = exp.config.concurrency.unwrap_or(DEFAULT_CONCURRENCY).clamp(1, 32);
    let rows = store.dataset_rows_by_index(&exp.dataset_id, &exp.row_indices)?;
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
        if let Err(e) = client.load(model).await {
            let msg = format!("{model} could not be loaded: {e}");
            for (idx, row) in &rows {
                if existing.contains(&(model.clone(), *idx)) {
                    continue;
                }
                store.insert_prediction(&experiment_id, &error_prediction(model, *idx, &task, row, &msg))?;
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
                let client = client.clone();
                let questions = questions.clone();
                let task = task.clone();
                let model = model.clone();
                let cancel = cancel.clone();
                async move {
                    if cancel.load(Ordering::Relaxed) {
                        return None;
                    }
                    Some(predict(&client, &model, &task, questions, idx, &row).await)
                }
            })
            .buffer_unordered(concurrency);

        while let Some(p) = results.next().await {
            let Some(p) = p else { continue };
            store.insert_prediction(&experiment_id, &p)?;
            done += 1;
            emit(Some(model), done, ExperimentStatus::Running, None);
        }
    }

    let status = if cancel.load(Ordering::Relaxed) { ExperimentStatus::Cancelled } else { ExperimentStatus::Completed };
    store.set_experiment_status(&experiment_id, status, None)?;
    emit(None, total, status, None);
    Ok(status)
}

async fn predict(
    client: &Client,
    model: &str,
    task: &TaskSpec,
    questions: indexmap::IndexMap<String, Question>,
    idx: usize,
    row: &Row,
) -> Prediction {
    let req = DecideRequest {
        model: model.to_string(),
        state: Some(task.state(row)),
        questions: Some(questions),
        ..Default::default()
    };
    let started = Instant::now();
    let gt = task.ground_truth(row).unwrap_or_default();
    match client.decide(&req).await {
        Ok(resp) => {
            let wall = started.elapsed().as_secs_f64() * 1000.0;
            let latency = if resp.eval_duration > 0 { resp.eval_duration as f64 / 1e6 } else { wall };
            match resp.answers.get(QUESTION_ID).map(|a| task.interpret(a)) {
                Some(Ok(i)) => Prediction {
                    model: model.to_string(),
                    row_idx: idx,
                    ground_truth: gt,
                    predicted: Some(i.predicted),
                    confidence: Some(i.confidence),
                    top_prob: Some(i.top_prob),
                    probabilities: Some(i.probabilities),
                    latency_ms: Some(latency),
                    error: None,
                },
                Some(Err(e)) => error_prediction(model, idx, task, row, &e.to_string()),
                None => error_prediction(model, idx, task, row, "answer missing from response"),
            }
        }
        Err(e) => error_prediction(model, idx, task, row, &e.to_string()),
    }
}

fn error_prediction(model: &str, idx: usize, task: &TaskSpec, row: &Row, msg: &str) -> Prediction {
    Prediction {
        model: model.to_string(),
        row_idx: idx,
        ground_truth: task.ground_truth(row).unwrap_or_default(),
        predicted: None,
        confidence: None,
        top_prob: None,
        probabilities: None,
        latency_ms: None,
        error: Some(msg.to_string()),
    }
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
    use crate::task::{LabelSpec, TaskKind};

    #[test]
    fn plan_filters_unknown_labels_and_samples() {
        let store = Store::open_in_memory().unwrap();
        let mut csv = String::from("text,label\n");
        for i in 0..50 {
            csv.push_str(&format!("t{i},{}\n", ["a", "b", "?"][i % 3]));
        }
        let d = store.insert_dataset("x", None, &parse_delimited(&csv, b',').unwrap()).unwrap();
        let mut cfg = ExperimentConfig {
            name: "e".into(),
            dataset_id: d.id,
            task: TaskSpec {
                kind: TaskKind::Choice,
                instructions: "?".into(),
                input_columns: vec!["text".into()],
                label_column: "label".into(),
                labels: vec![
                    LabelSpec { value: "a".into(), description: None },
                    LabelSpec { value: "b".into(), description: None },
                ],
                positive_label: None,
                threshold: None,
            },
            models: vec!["laya".into()],
            sample_size: None,
            concurrency: None,
        };
        let all = plan_rows(&store, &cfg).unwrap();
        assert_eq!(all.len(), 34);
        cfg.sample_size = Some(10);
        let s1 = plan_rows(&store, &cfg).unwrap();
        assert_eq!(s1.len(), 10);
        assert_eq!(s1, plan_rows(&store, &cfg).unwrap(), "sampling is deterministic");
        assert!(s1.windows(2).all(|w| w[0] < w[1]));
    }
}
