//! Fine-tuning: train a decision model on an evaluation's labels and serve it next to Ollaya.
//!
//! Training runs Unsloth (MLX on Apple silicon) in a Python environment that ClassifAI installs on
//! request into `<app data>/trainer` with uv: Python, PyTorch, MLX and Unsloth, plus a llama.cpp
//! release for the GGUF converter and the server. Unsloth's decision code is AGPL-3.0, so it is
//! only ever run as a separate process; nothing of it is bundled.
//!
//! A job splits the evaluation's labelled rows into train / calibration / test, writes the first
//! two in Unsloth's decision format, runs `train_decision.py` (progress as `@@{json}` lines on
//! stdout), moves the exported GGUF into `<app data>/finetunes/models/<slug>.gguf` and evaluates
//! the result on the held-out test rows against the evaluation's local models.
//!
//! Fine-tuned models are called `ft:<slug>`. One `llama-server` in router mode serves the models
//! folder at `/v1/systemone`, loading each model on its first request.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::cloud::{self, CloudAnswers};
use crate::dataset::{ParsedDataset, Row};
use crate::decider::Decider;
use crate::ollaya::{LocalModel, ModelDetails, Question};
use crate::providers::{Provider, ProviderKind};
use crate::store::{ExperimentConfig, ExperimentStatus, Store};
use crate::task::{with_earlier_answers, TaskKind, TaskSpec};
use crate::{now_rfc3339, runner, Error, Result};

/// The training script, written into the trainer folder before every run.
const TRAIN_SCRIPT: &str = include_str!("../../../scripts/finetune/train_decision.py");

/// Versions the trainer installs. Unsloth's MLX decision training landed after its last PyPI
/// release, so Unsloth and unsloth-zoo come from pinned GitHub commits.
pub const UV_VERSION: &str = "0.11.2";
pub const UNSLOTH_COMMIT: &str = "3a1b694";
pub const UNSLOTH_ZOO_COMMIT: &str = "f787f63d3411c00633d1768f617348ee6867ed37";
/// The first llama.cpp with decision GGUFs is b11443; this one is tested with ClassifAI.
pub const LLAMA_CPP_TAG: &str = "b11559";
const PYTHON_PACKAGES: &[&str] = &[
    "torch==2.14.1",
    "mlx==0.32.3",
    "transformers==5.17.0",
    "accelerate==1.15.0",
    "peft==0.21.2",
    "gguf==0.19.0",
    "datasets==4.8.5",
];
/// Bumped when the environment's contents change, so an older install is offered an update.
const TRAINER_VERSION: u32 = 1;

pub const MODEL_PREFIX: &str = "ft:";

// ---- base models ----------------------------------------------------------------------------

/// A model a fine-tune can start from.
#[derive(Debug, Clone, Serialize)]
pub struct Base {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// Hugging Face repository (and subfolder) Unsloth loads.
    pub repo: &'static str,
    pub subfolder: Option<&'static str>,
    /// `encoder` or `decoder`
    pub kind: &'static str,
    pub params: &'static str,
    /// The same model in Ollaya, compared against in the held-out evaluation.
    pub ollaya: Option<&'static str>,
    /// A plain language model that gets a new decision head (it knows nothing about decisions yet).
    pub new_head: bool,
    pub min_memory_gb: u32,
    /// Training seconds per 1,000 rows and pass on an M2 Max, for the estimate.
    pub seconds_per_1k_rows: f64,
    /// `seconds_per_1k_rows` was measured, not extrapolated.
    pub measured: bool,
    pub max_length: u32,
    pub load_in_4bit: bool,
    pub learning_rate: f64,
    pub head_learning_rate: Option<f64>,
    pub recommended: bool,
    /// The weights' licence; a fine-tune is a derivative of them and carries it.
    pub license: &'static str,
}

pub const BASES: &[Base] = &[
    Base {
        id: "laya-en",
        title: "Laya English",
        description: "ModernBERT-large encoder with a decision head; what Ollaya runs as laya:en. Fast to train, a good first choice for English text.",
        repo: "convaiinnovations/laya",
        subfolder: None,
        kind: "encoder",
        params: "421M",
        ollaya: Some("laya:en"),
        new_head: false,
        min_memory_gb: 8,
        seconds_per_1k_rows: 125.0,
        measured: true,
        max_length: 512,
        load_in_4bit: false,
        learning_rate: 1e-4,
        head_learning_rate: None,
        recommended: true,
        license: "Apache-2.0",
    },
    Base {
        id: "laya-multilingual",
        title: "Laya multilingual",
        description: "mmBERT-base encoder with a decision head; what Ollaya runs as laya:multilingual. For text that isn't (only) English.",
        repo: "convaiinnovations/laya",
        subfolder: Some("multilingual"),
        kind: "encoder",
        params: "322M",
        ollaya: Some("laya:multilingual"),
        new_head: false,
        min_memory_gb: 8,
        seconds_per_1k_rows: 100.0,
        measured: false,
        max_length: 1024,
        load_in_4bit: false,
        learning_rate: 1e-4,
        head_learning_rate: None,
        recommended: false,
        license: "Apache-2.0",
    },
    Base {
        id: "qwen3.5-0.8b",
        title: "Qwen3.5 0.8B + new head",
        description: "A small language model turned into a decision model. Reads longer inputs than Laya; starts from zero, so it needs a few hundred labelled rows.",
        repo: "unsloth/Qwen3.5-0.8B",
        subfolder: None,
        kind: "decoder",
        params: "0.8B",
        ollaya: None,
        new_head: true,
        min_memory_gb: 16,
        seconds_per_1k_rows: 400.0,
        measured: true,
        max_length: 2048,
        load_in_4bit: false,
        learning_rate: 1e-4,
        head_learning_rate: Some(3e-4),
        recommended: false,
        license: "Apache-2.0",
    },
    Base {
        id: "qwen3.5-2b",
        title: "Qwen3.5 2B + new head",
        description: "A larger language model turned into a decision model. Slower to train and run; for harder questions and long inputs.",
        repo: "unsloth/Qwen3.5-2B",
        subfolder: None,
        kind: "decoder",
        params: "2B",
        ollaya: None,
        new_head: true,
        min_memory_gb: 24,
        seconds_per_1k_rows: 1000.0,
        measured: false,
        max_length: 2048,
        load_in_4bit: false,
        learning_rate: 1e-4,
        head_learning_rate: Some(3e-4),
        recommended: false,
        license: "Apache-2.0",
    },
    Base {
        id: "clef",
        title: "Clef Flash",
        description: "Cloudflare's Qwen3.5-9B decision model; what Ollaya runs as clef. The most accurate base, trained in 4-bit. Takes hours and a lot of memory.",
        repo: "Cloudflare/clef-flash",
        subfolder: None,
        kind: "decoder",
        params: "9B",
        ollaya: Some("clef"),
        new_head: false,
        min_memory_gb: 48,
        seconds_per_1k_rows: 4500.0,
        measured: false,
        max_length: 2048,
        load_in_4bit: true,
        learning_rate: 5e-5,
        head_learning_rate: None,
        recommended: false,
        license: "Apache-2.0",
    },
];

impl Base {
    /// The checkpoint layout, so the trainer downloads only the files Unsloth reads.
    fn layout(&self) -> &'static str {
        if self.new_head {
            "lm"
        } else if self.id == "clef" {
            "clef"
        } else {
            "laya"
        }
    }
}

pub fn base(id: &str) -> Result<&'static Base> {
    BASES.iter().find(|b| b.id == id).ok_or_else(|| Error::invalid(format!("unknown base model \"{id}\"")))
}

// ---- jobs -----------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Passes over the training rows.
    pub epochs: f64,
    pub learning_rate: f64,
    pub lora_rank: u32,
    /// Share of labelled rows held out for the before/after test (0.05–0.5).
    pub holdout: f64,
    pub max_length: u32,
    pub seed: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FineTuneInput {
    pub name: String,
    pub base: String,
    /// What to learn: dataset, input columns, questions and label columns, as for an evaluation.
    /// `models` are the models to compare against on the held-out rows (may be empty).
    pub config: ExperimentConfig,
    /// The evaluation the setup was copied from, if any.
    #[serde(default)]
    pub source_experiment_id: Option<String>,
    pub settings: Settings,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Preparing,
    /// The comparison models answer the held-out rows (the "before").
    Baseline,
    Training,
    Evaluating,
    Ready,
    Failed,
    Cancelled,
}

impl Status {
    pub fn is_active(self) -> bool {
        matches!(self, Status::Queued | Status::Preparing | Status::Baseline | Status::Training | Status::Evaluating)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Progress {
    /// What the trainer is doing: loading, baseline, training, calibrating, exporting.
    pub stage: Option<String>,
    pub step: u64,
    pub total_steps: u64,
    pub epoch: f64,
    /// Seconds since training (the step loop) started.
    pub elapsed_s: f64,
    /// (step, loss)
    pub loss: Vec<(u64, f64)>,
    /// Rows per step and training records, for "rows seen" and pass boundaries.
    #[serde(default)]
    pub batch_size: u64,
    #[serde(default)]
    pub records: u64,
    /// The base model's download, while loading (absent before it starts).
    #[serde(default)]
    pub download: Option<Download>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Download {
    /// Bytes downloaded of `total` (both 0 when everything was cached).
    pub done: u64,
    pub total: u64,
    pub files_done: u64,
    pub files: u64,
    /// Bytes that were already in the Hugging Face cache.
    pub cached: u64,
    pub elapsed_s: f64,
    /// The download could not be planned (offline, gated repository); loading reports the cause.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Split {
    /// Rows with a label for at least one question.
    pub labelled: usize,
    pub train: usize,
    pub calibration: usize,
    pub test: usize,
    /// Training records (a row with follow-ups can give several).
    pub records: usize,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Scores {
    pub accuracy: f64,
    pub ece: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FineTune {
    pub id: String,
    pub name: String,
    /// `ft:<slug>`: how the model is asked for everywhere in the app.
    pub model: String,
    pub base: String,
    pub base_title: String,
    /// The evaluation the setup was copied from (none when set up from a dataset).
    #[serde(default)]
    pub experiment_id: Option<String>,
    #[serde(default)]
    pub experiment_name: Option<String>,
    /// The setup: dataset, inputs, questions; `models` are compared against on the held-out rows.
    #[serde(default)]
    pub config: Option<ExperimentConfig>,
    pub dataset_id: String,
    pub dataset_name: String,
    /// Question ids trained on.
    pub questions: Vec<String>,
    pub settings: Settings,
    pub status: Status,
    pub progress: Progress,
    pub split: Option<Split>,
    /// Accuracy and calibration error on the calibration rows, from the trainer.
    pub before: Option<Scores>,
    pub after: Option<Scores>,
    /// The held-out evaluation: the comparison models before training, the fine-tune after.
    pub eval_experiment_id: Option<String>,
    pub test_dataset_id: Option<String>,
    pub size_bytes: u64,
    pub train_seconds: Option<f64>,
    /// Weights of the model, and how many of them training changes (LoRA adapters and head).
    #[serde(default)]
    pub parameters: Option<u64>,
    #[serde(default)]
    pub trainable_parameters: Option<u64>,
    /// [`Analysis`] is saved for this fine-tune (read it with [`Manager::analysis`]).
    #[serde(default)]
    pub has_analysis: bool,
    pub error: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// Every calibration row's answer before and after training: for per-label accuracy, the
/// calibration diagram and the rows the model learned. Kept in `analysis.json` in the job folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Analysis {
    pub rows: Vec<AnalysisRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisRow {
    pub row: usize,
    pub question: String,
    /// The input, cut to 400 characters.
    pub text: String,
    /// The label (choice) or true/false (yes/no).
    pub gold: Value,
    pub before: Option<Value>,
    /// Probability the model gave its answer.
    pub before_p: Option<f64>,
    pub after: Option<Value>,
    pub after_p: Option<f64>,
}

impl Analysis {
    fn apply(&mut self, event: &Value) {
        let items = event["items"].as_array().cloned().unwrap_or_default();
        let key = |it: &Value| (it[0].as_u64().unwrap_or(0) as usize, it[1].as_str().unwrap_or("").to_string());
        if event["event"] == "gold" {
            self.rows = items
                .iter()
                .map(|it| {
                    let (row, question) = key(it);
                    AnalysisRow { row, question, gold: it[2].clone(), text: it[3].as_str().unwrap_or("").into(), before: None, before_p: None, after: None, after_p: None }
                })
                .collect();
            return;
        }
        let after = event["which"] == "after";
        for it in &items {
            let k = key(it);
            if let Some(r) = self.rows.iter_mut().find(|r| r.row == k.0 && r.question == k.1) {
                if after {
                    r.after = Some(it[2].clone());
                    r.after_p = it[3].as_f64();
                } else {
                    r.before = Some(it[2].clone());
                    r.before_p = it[3].as_f64();
                }
            }
        }
    }
}

/// What a fine-tune from an evaluation would train on, for the setup form.
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub split: Split,
    pub questions: Vec<QuestionPreview>,
    /// Problems that block training.
    pub errors: Vec<String>,
    /// Things worth knowing that don't block it.
    pub warnings: Vec<String>,
    /// Local models of the evaluation, re-run on the test rows for comparison.
    pub compare_with: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuestionPreview {
    pub id: String,
    pub instructions: String,
    pub kind: TaskKind,
    /// label -> labelled rows
    pub labels: IndexMap<String, usize>,
}

fn slugify(name: &str) -> String {
    let mut s = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    let s = s.trim_end_matches('-').chars().take(40).collect::<String>();
    if s.is_empty() { "model".into() } else { s }
}

const FINETUNES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS finetunes (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
);
"#;

impl Store {
    fn finetunes_table(&self) -> Result<()> {
        self.conn().execute_batch(FINETUNES_TABLE)?;
        Ok(())
    }

    pub fn list_finetunes(&self) -> Result<Vec<FineTune>> {
        self.finetunes_table()?;
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT data FROM finetunes ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter().map(|d| Ok(serde_json::from_str(d)?)).collect()
    }

    pub fn get_finetune(&self, id: &str) -> Result<FineTune> {
        self.finetunes_table()?;
        let data: Option<String> =
            self.conn().query_row("SELECT data FROM finetunes WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        Ok(serde_json::from_str(&data.ok_or_else(|| Error::NotFound(format!("fine-tune {id}")))?)?)
    }

    pub fn save_finetune(&self, f: &FineTune) -> Result<()> {
        self.finetunes_table()?;
        self.conn().execute(
            "INSERT INTO finetunes (id, model, created_at, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![f.id, f.model, f.created_at, serde_json::to_string(f)?],
        )?;
        Ok(())
    }

    pub fn delete_finetune_row(&self, id: &str) -> Result<()> {
        self.finetunes_table()?;
        self.conn().execute("DELETE FROM finetunes WHERE id = ?1", [id])?;
        Ok(())
    }

    fn model_name_taken(&self, model: &str) -> Result<bool> {
        self.finetunes_table()?;
        Ok(self.conn().query_row("SELECT COUNT(*) FROM finetunes WHERE model = ?1", [model], |r| r.get::<_, i64>(0))? > 0)
    }
}

// ---- training data ----------------------------------------------------------------------------

/// The evaluation's rows with label corrections applied.
fn labelled_rows(store: &Store, config: &ExperimentConfig) -> Result<Vec<(usize, Row)>> {
    let dataset = store.get_dataset(&config.dataset_id)?;
    let mut rows = store.dataset_rows(&config.dataset_id, 0, dataset.row_count)?;
    crate::store::apply_corrections(&mut rows, &store.corrections_map(&config.dataset_id)?);
    rows.retain(|(_, r)| config.has_ground_truth(r));
    Ok(rows)
}

/// The gold answer of a task on a row, as Unsloth reads it: the label for a choice question,
/// true/false for a yes/no one.
fn gold(task: &TaskSpec, row: &Row) -> Option<Value> {
    let label = task.ground_truth(row)?;
    Some(match task.kind {
        TaskKind::Choice => Value::String(label),
        TaskKind::Binary => Value::Bool(Some(label.as_str()) == task.positive_label_value()),
    })
}

/// Training records of one row, asked the way the experiment runner asks: the questions without a
/// condition together, then each follow-up whose condition the row's labels meet, with the earlier
/// labels added to the input.
fn records(config: &ExperimentConfig, row: &Row) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let question = |t: &TaskSpec| serde_json::to_value::<Question>(t.question(config.context.as_deref()));
    let roots: Vec<&TaskSpec> = config.roots().into_iter().filter(|t| t.ground_truth(row).is_some()).collect();
    if !roots.is_empty() {
        let mut questions = serde_json::Map::new();
        let mut golds = serde_json::Map::new();
        for t in &roots {
            questions.insert(t.id.clone(), question(t)?);
            golds.insert(t.id.clone(), gold(t, row).expect("filtered"));
        }
        out.push(json!({"state": config.state(row), "questions": questions, "gold": golds}));
    }
    for t in config.tasks.iter().filter(|t| t.when.is_some()) {
        let Some(g) = gold(t, row) else { continue };
        let ancestors = config.ancestors(t);
        let mut earlier = Vec::new();
        let mut applies = true;
        let mut child = t;
        for a in ancestors.iter().rev() {
            let w = child.when.as_ref().expect("follow-up");
            match a.ground_truth(row) {
                Some(l) if w.answers.contains(&l) => earlier.insert(0, (a.instructions.trim().to_string(), l)),
                _ => {
                    applies = false;
                    break;
                }
            }
            child = a;
        }
        if !applies {
            continue;
        }
        out.push(json!({
            "state": with_earlier_answers(config.state(row), &earlier),
            "questions": {t.id.clone(): question(t)?},
            "gold": {t.id.clone(): g},
        }));
    }
    Ok(out)
}

/// The label rows are stratified by: the first question's label, or "" without one.
fn stratum(config: &ExperimentConfig, row: &Row) -> String {
    config.tasks.first().and_then(|t| t.ground_truth(row)).unwrap_or_default()
}

/// A small deterministic generator (SplitMix64), so a split is the same for the same seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

/// Row positions split into (train, calibration, test), stratified by [`stratum`]. Each label
/// gives `holdout` of its rows to the test set, then about 10% of the rest (at least 20 rows, at
/// most 300 overall) to calibration.
fn split_rows(strata: &[String], holdout: f64, seed: u64) -> (Vec<usize>, Vec<usize>, Vec<usize>) {
    let mut groups: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, s) in strata.iter().enumerate() {
        groups.entry(s.as_str()).or_default().push(i);
    }
    let mut rng = Rng(seed);
    let (mut train, mut calib, mut test) = (Vec::new(), Vec::new(), Vec::new());
    let rest_total = strata.len() as f64 * (1.0 - holdout);
    let calib_share = if rest_total <= 0.0 { 0.0 } else { (rest_total * 0.1).clamp(20f64.min(rest_total / 3.0), 300.0) / rest_total };
    for (_, mut members) in groups {
        rng.shuffle(&mut members);
        let n = members.len();
        let n_test = if n >= 2 { ((n as f64 * holdout).round() as usize).max(1) } else { 0 };
        let rest = n - n_test;
        let n_calib = if rest >= 3 { (rest as f64 * calib_share).round() as usize } else { 0 };
        test.extend_from_slice(&members[..n_test]);
        calib.extend_from_slice(&members[n_test..n_test + n_calib]);
        train.extend_from_slice(&members[n_test + n_calib..]);
    }
    rng.shuffle(&mut train);
    (train, calib, test)
}

/// The fine-tune whose held-out test rows a dataset holds, if any: training on them would make
/// that fine-tune's test meaningless.
fn held_out_by(store: &Store, dataset_id: &str) -> Result<Option<FineTune>> {
    Ok(store.list_finetunes()?.into_iter().find(|f| f.test_dataset_id.as_deref() == Some(dataset_id)))
}

pub fn preview(store: &Store, config: &ExperimentConfig, holdout: f64, base_id: Option<&str>) -> Result<Preview> {
    let rows = labelled_rows(store, config)?;
    let strata: Vec<String> = rows.iter().map(|(_, r)| stratum(config, r)).collect();
    let (train, calib, test) = split_rows(&strata, holdout.clamp(0.05, 0.5), 7);
    let mut records = 0;
    for &i in &train {
        records += records_of(config, &rows[i].1)?;
    }
    let questions: Vec<QuestionPreview> = config
        .tasks
        .iter()
        .map(|t| {
            let mut labels: IndexMap<String, usize> = t.label_values().into_iter().map(|l| (l, 0)).collect();
            for (_, r) in &rows {
                if let Some(l) = t.ground_truth(r) {
                    *labels.entry(l).or_default() += 1;
                }
            }
            QuestionPreview { id: t.id.clone(), instructions: t.instructions.clone(), kind: t.kind, labels }
        })
        .collect();

    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if let Some(f) = held_out_by(store, &config.dataset_id)? {
        errors.push(format!("This dataset holds the rows held out to test “{}”. Training on them would make that test meaningless.", f.name));
    }
    if rows.is_empty() {
        errors.push("None of the evaluation's rows have a label. Fine-tuning learns from labelled rows.".into());
    } else if train.len() < 50 {
        errors.push(format!("Only {} rows would be left for training; label at least 100 rows.", train.len()));
    } else if train.len() < 200 {
        warnings.push(format!("{} training rows is few; results get more reliable from about 300.", train.len()));
    }
    for q in &questions {
        let thin: Vec<&str> = q.labels.iter().filter(|(_, &n)| n < 10).map(|(l, _)| l.as_str()).collect();
        if !thin.is_empty() && !rows.is_empty() {
            warnings.push(format!(
                "{}: {} {} fewer than 10 labelled rows, so the model will rarely learn to pick {}.",
                q.id,
                thin.join(", "),
                if thin.len() == 1 { "has" } else { "have" },
                if thin.len() == 1 { "it" } else { "them" }
            ));
        }
    }
    if config.tasks.iter().any(|t| t.when.is_some()) {
        warnings.push("Follow-up questions are trained with the labelled answers to earlier questions added to the input.".into());
    }
    if test.len() < 30 && !rows.is_empty() {
        warnings.push(format!("Only {} rows are held out, so the before/after comparison will be rough.", test.len()));
    }
    let base = base_id.and_then(|b| base(b).ok());
    if let Some(b) = base {
        if b.kind == "encoder" {
            let long = rows.iter().filter(|(_, r)| crate::analysis::input_text(config, r).len() > b.max_length as usize * 4).count();
            if long * 10 > rows.len().max(1) {
                warnings.push(format!(
                    "{long} rows are longer than {} reads (about {} tokens); their ends are cut off. A Qwen base reads longer inputs.",
                    b.title, b.max_length
                ));
            }
        }
    }
    Ok(Preview {
        split: Split { labelled: rows.len(), train: train.len(), calibration: calib.len(), test: test.len(), records },
        questions,
        errors,
        warnings,
        compare_with: config.models.clone(),
    })
}

fn records_of(config: &ExperimentConfig, row: &Row) -> Result<usize> {
    Ok(records(config, row)?.len())
}

// ---- trainer environment ------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TrainerStatus {
    /// This machine can train (Apple silicon, macOS 14 or later).
    pub supported: bool,
    pub reason: Option<String>,
    pub installed: bool,
    /// Installed, but by an older ClassifAI: reinstall to update.
    pub outdated: bool,
    pub memory_gb: f64,
    pub disk_free_gb: f64,
    pub path: String,
    /// Bytes used by the trainer folder.
    pub size_bytes: u64,
}

#[derive(Clone)]
pub struct Trainer {
    root: PathBuf,
}

fn sysctl(name: &str) -> Option<String> {
    let out = std::process::Command::new("sysctl").args(["-n", name]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn disk_free_gb(path: &Path) -> f64 {
    let mut p = path.to_path_buf();
    while !p.exists() {
        if !p.pop() {
            break;
        }
    }
    let out = std::process::Command::new("df").arg("-k").arg(&p).output();
    out.ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            text.lines().nth(1)?.split_whitespace().nth(3)?.parse::<f64>().ok()
        })
        .map(|kb| kb / 1024.0 / 1024.0)
        .unwrap_or(0.0)
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

pub fn memory_gb() -> f64 {
    sysctl("hw.memsize").and_then(|s| s.parse::<f64>().ok()).map(|b| b / 1024f64.powi(3)).unwrap_or(0.0)
}

impl Trainer {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("trainer") }
    }

    fn uv(&self) -> PathBuf {
        self.root.join("bin").join("uv")
    }
    pub fn python(&self) -> PathBuf {
        self.root.join("venv").join("bin").join("python")
    }
    fn script(&self) -> PathBuf {
        self.root.join("train_decision.py")
    }
    pub fn llama_server(&self) -> PathBuf {
        self.root.join("llama.cpp").join("bin").join("llama-server")
    }
    fn llama_src(&self) -> PathBuf {
        self.root.join("llama.cpp").join("src")
    }
    fn marker(&self) -> PathBuf {
        self.root.join("installed.json")
    }

    fn installed_version(&self) -> Option<u32> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(self.marker()).ok()?).ok()?;
        v["version"].as_u64().map(|v| v as u32)
    }

    pub fn status(&self) -> TrainerStatus {
        let (supported, reason) = support();
        let version = self.installed_version();
        let installed = version.is_some() && self.python().is_file() && self.llama_server().is_file();
        TrainerStatus {
            supported,
            reason,
            installed,
            outdated: installed && version != Some(TRAINER_VERSION),
            memory_gb: memory_gb(),
            disk_free_gb: disk_free_gb(&self.root),
            path: self.root.display().to_string(),
            size_bytes: if self.root.is_dir() { dir_size(&self.root) } else { 0 },
        }
    }

    /// Install (or update) uv, Python with Unsloth, and llama.cpp. Every step's output goes to
    /// `on_line`. Safe to run again: each step replaces what it installs.
    pub async fn install(&self, on_line: &(dyn Fn(String) + Send + Sync)) -> Result<()> {
        let (supported, reason) = support();
        if !supported {
            return Err(Error::invalid(reason.unwrap_or_else(|| "fine-tuning is not supported on this machine".into())));
        }
        tokio::fs::create_dir_all(self.root.join("bin")).await?;
        let _ = tokio::fs::remove_file(self.marker()).await;

        on_line(format!("Downloading uv {UV_VERSION}…"));
        let uv_url = format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-aarch64-apple-darwin.tar.gz");
        let staging = self.root.join("staging");
        let _ = tokio::fs::remove_dir_all(&staging).await;
        tokio::fs::create_dir_all(&staging).await?;
        let tarball = staging.join("uv.tar.gz");
        download(&uv_url, &tarball, on_line).await?;
        run(Command::new("tar").arg("xzf").arg(&tarball).arg("-C").arg(&staging), on_line).await?;
        tokio::fs::rename(staging.join("uv-aarch64-apple-darwin").join("uv"), self.uv()).await?;

        on_line("Creating the Python environment (Python 3.12)…".into());
        let _ = tokio::fs::remove_dir_all(self.root.join("venv")).await;
        run(self.uv_command().args(["venv", "--python", "3.12"]).arg(self.root.join("venv")), on_line).await?;

        on_line("Installing PyTorch, MLX and Unsloth…".into());
        let mut pip = self.uv_command();
        pip.args(["pip", "install", "--python"]).arg(self.python()).env("SETUPTOOLS_SCM_PRETEND_VERSION", "2026.10.3");
        pip.arg(format!("unsloth @ https://github.com/unslothai/unsloth/archive/{UNSLOTH_COMMIT}.tar.gz"));
        pip.arg(format!("unsloth-zoo @ https://github.com/unslothai/unsloth-zoo/archive/{UNSLOTH_ZOO_COMMIT}.tar.gz"));
        pip.args(PYTHON_PACKAGES);
        run(&mut pip, on_line).await?;

        on_line(format!("Downloading llama.cpp {LLAMA_CPP_TAG}…"));
        let llama = self.root.join("llama.cpp");
        let _ = tokio::fs::remove_dir_all(&llama).await;
        tokio::fs::create_dir_all(self.llama_src()).await?;
        let bin_tar = staging.join("llama-bin.tar.gz");
        download(
            &format!("https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_CPP_TAG}/llama-{LLAMA_CPP_TAG}-bin-macos-arm64.tar.gz"),
            &bin_tar,
            on_line,
        )
        .await?;
        run(Command::new("tar").arg("xzf").arg(&bin_tar).arg("-C").arg(&staging), on_line).await?;
        tokio::fs::rename(staging.join(format!("llama-{LLAMA_CPP_TAG}")), llama.join("bin")).await?;
        let src_tar = staging.join("llama-src.tar.gz");
        download(&format!("https://github.com/ggml-org/llama.cpp/archive/refs/tags/{LLAMA_CPP_TAG}.tar.gz"), &src_tar, on_line).await?;
        // The converter only: convert_hf_to_gguf.py, conversion/ and gguf-py/.
        let prefix = format!("llama.cpp-{LLAMA_CPP_TAG}");
        run(
            Command::new("tar")
                .arg("xzf")
                .arg(&src_tar)
                .arg("-C")
                .arg(self.llama_src())
                .arg("--strip-components")
                .arg("1")
                .arg(format!("{prefix}/convert_hf_to_gguf.py"))
                .arg(format!("{prefix}/conversion"))
                .arg(format!("{prefix}/gguf-py")),
            on_line,
        )
        .await?;
        // Downloaded binaries carry the quarantine flag, which would stop them from running.
        let _ = Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&llama).status().await;

        on_line("Checking the installation…".into());
        run(Command::new(self.python()).args(["-c", "import mlx.core, torch, unsloth_zoo.mlx.decision; print('ok')"]), on_line).await?;
        run(Command::new(self.llama_server()).arg("--version"), on_line).await?;

        let _ = tokio::fs::remove_dir_all(&staging).await;
        // The download cache would double the size on disk; an update downloads again.
        let _ = run(self.uv_command().args(["cache", "clean"]), on_line).await;
        tokio::fs::write(
            self.marker(),
            serde_json::to_string_pretty(&json!({
                "version": TRAINER_VERSION,
                "unsloth": UNSLOTH_COMMIT,
                "unsloth_zoo": UNSLOTH_ZOO_COMMIT,
                "llama_cpp": LLAMA_CPP_TAG,
                "installed_at": now_rfc3339(),
            }))?,
        )
        .await?;
        on_line("The trainer is ready.".into());
        Ok(())
    }

    pub async fn uninstall(&self) -> Result<()> {
        if self.root.is_dir() {
            tokio::fs::remove_dir_all(&self.root).await?;
        }
        Ok(())
    }

    fn uv_command(&self) -> Command {
        let mut c = Command::new(self.uv());
        // uv's own Python only: a system or Homebrew one can be upgraded away under the venv.
        c.env("UV_PYTHON_INSTALL_DIR", self.root.join("python"))
            .env("UV_PYTHON_PREFERENCE", "only-managed")
            .env("UV_CACHE_DIR", self.root.join("cache"))
            .env("UV_NO_PROGRESS", "1");
        c
    }
}

/// Training needs Apple silicon and macOS 14 or later (Unsloth's MLX path).
fn support() -> (bool, Option<String>) {
    if !(cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) {
        return (false, Some("Fine-tuning runs on Macs with Apple silicon for now.".into()));
    }
    let major = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).split('.').next()?.trim().parse::<u32>().ok());
    if major.is_some_and(|m| m < 14) {
        return (false, Some("Fine-tuning needs macOS 14 or later.".into()));
    }
    (true, None)
}

async fn download(url: &str, to: &Path, on_line: &(dyn Fn(String) + Send + Sync)) -> Result<()> {
    let mut resp = reqwest::get(url).await?.error_for_status()?;
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(to).await?;
    let mut done: u64 = 0;
    let mut last_report = 0u64;
    while let Some(chunk) = resp.chunk().await? {
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        if done - last_report > 16 << 20 {
            last_report = done;
            on_line(match total {
                Some(t) => format!("  {:.0} of {:.0} MB", done as f64 / 1e6, t as f64 / 1e6),
                None => format!("  {:.0} MB", done as f64 / 1e6),
            });
        }
    }
    file.flush().await?;
    Ok(())
}

/// Run a command to completion, passing its output lines on.
async fn run(cmd: &mut Command, on_line: &(dyn Fn(String) + Send + Sync)) -> Result<()> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn()?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)]
        .into_iter()
        .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx.send(l);
            }
        });
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    while let Some(line) = rx.recv().await {
        tail.push(line.clone());
        if tail.len() > 20 {
            tail.remove(0);
        }
        on_line(line);
    }
    let status = child.wait().await?;
    if !status.success() {
        return Err(Error::invalid(format!("{} failed ({status}): {}", program_name(cmd), tail.join("\n"))));
    }
    Ok(())
}

fn program_name(cmd: &Command) -> String {
    Path::new(cmd.as_std().get_program()).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

// ---- serving --------------------------------------------------------------------------------

/// One `llama-server` in router mode over the fine-tuned models folder, started on first use.
pub struct Server {
    bin: PathBuf,
    models_dir: PathBuf,
    log: PathBuf,
    http: reqwest::Client,
    inner: tokio::sync::Mutex<Option<(Child, String)>>,
}

impl Server {
    pub fn new(data_dir: &Path, trainer: &Trainer) -> Self {
        Self {
            bin: trainer.llama_server(),
            models_dir: data_dir.join("finetunes").join("models"),
            log: data_dir.join("logs").join("llama-server.log"),
            http: reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).build().expect("reqwest client"),
            inner: tokio::sync::Mutex::new(None),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    async fn alive(&self, url: &str) -> bool {
        matches!(self.http.get(format!("{url}/models")).timeout(Duration::from_secs(2)).send().await, Ok(r) if r.status().is_success())
    }

    /// The server's base URL, starting it when it isn't running.
    pub async fn ensure(&self) -> Result<String> {
        let mut inner = self.inner.lock().await;
        if let Some((child, url)) = inner.as_mut() {
            if child.try_wait().ok().flatten().is_none() && self.alive(url).await {
                return Ok(url.clone());
            }
        }
        if !self.bin.is_file() {
            return Err(Error::invalid("fine-tuned models need the trainer's llama.cpp; set it up on the Fine-tune page"));
        }
        tokio::fs::create_dir_all(&self.models_dir).await?;
        if let Some(dir) = self.log.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let port = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let log = std::fs::File::create(&self.log)?;
        let child = Command::new(&self.bin)
            .arg("--models-dir")
            .arg(&self.models_dir)
            .args(["--models-max", "2", "--sleep-idle-seconds", "600", "--host", "127.0.0.1", "--port", &port.to_string()])
            .stdout(Stdio::null())
            .stderr(log)
            .kill_on_drop(true)
            .spawn()?;
        let url = format!("http://127.0.0.1:{port}");
        *inner = Some((child, url.clone()));
        for _ in 0..120 {
            if self.alive(&url).await {
                return Ok(url);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(Error::invalid(format!("llama-server did not start within 30 s; see {}", self.log.display())))
    }

    /// Stop the server; it restarts on the next request (and sees added or removed models).
    pub async fn restart(&self) {
        if let Some((mut child, _)) = self.inner.lock().await.take() {
            let _ = child.kill().await;
        }
    }

    pub async fn decide(&self, slug: &str, state: &Value, questions: &IndexMap<String, Question>) -> Result<CloudAnswers> {
        if !self.models_dir.join(format!("{slug}.gguf")).is_file() {
            return Err(Error::NotFound(format!("fine-tuned model {MODEL_PREFIX}{slug}")));
        }
        let url = self.ensure().await?;
        let provider = Provider {
            id: "finetuned".into(),
            kind: ProviderKind::Custom,
            name: "Fine-tuned".into(),
            base_url: Some(url),
            account_id: None,
            has_key: false,
            key_hint: None,
            builtin: true,
        };
        cloud::decide(&self.http, &provider, None, slug, state, questions).await
    }
}

// ---- jobs -----------------------------------------------------------------------------------

/// Starts, runs and cancels fine-tunes, one at a time.
pub struct Manager {
    data_dir: PathBuf,
    pub trainer: Trainer,
    pub server: Arc<Server>,
    store: Arc<Store>,
    decider: Arc<Decider>,
    worker: tokio::sync::Mutex<()>,
    cancels: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Manager {
    pub fn new(data_dir: &Path, store: Arc<Store>, decider: Arc<Decider>) -> Arc<Self> {
        let trainer = Trainer::new(data_dir);
        let server = Arc::new(Server::new(data_dir, &trainer));
        decider.set_finetune_server(server.clone());
        let manager = Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            trainer,
            server,
            store,
            decider,
            worker: tokio::sync::Mutex::new(()),
            cancels: std::sync::Mutex::new(HashMap::new()),
        });
        // Jobs that were running when the app quit can't be resumed.
        if let Ok(list) = manager.store.list_finetunes() {
            for mut f in list.into_iter().filter(|f| f.status.is_active()) {
                f.status = Status::Failed;
                f.error = Some("Interrupted: ClassifAI was closed while this fine-tune was running.".into());
                f.finished_at = Some(now_rfc3339());
                let _ = manager.store.save_finetune(&f);
            }
        }
        manager
    }

    fn job_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("finetunes").join("jobs").join(id)
    }

    fn gguf_path(&self, model: &str) -> PathBuf {
        self.server.models_dir().join(format!("{}.gguf", model.trim_start_matches(MODEL_PREFIX)))
    }

    /// Fine-tuned models that are ready, as local models for the model pickers.
    pub fn local_models(&self) -> Vec<LocalModel> {
        self.store
            .list_finetunes()
            .unwrap_or_default()
            .into_iter()
            .filter(|f| f.status == Status::Ready)
            .map(|f| LocalModel {
                name: f.model.clone(),
                modified_at: f.finished_at.clone().unwrap_or_default(),
                size: f.size_bytes,
                details: ModelDetails {
                    format: "gguf".into(),
                    family: "fine-tune".into(),
                    parameter_size: base(&f.base).map(|b| b.params.to_string()).unwrap_or_default(),
                    quantization_level: "Q8_0".into(),
                },
            })
            .collect()
    }

    /// Queue a fine-tune; it starts when no other one is running. `on_update` gets every change.
    pub fn create(self: &Arc<Self>, input: FineTuneInput, on_update: Arc<dyn Fn(&FineTune) + Send + Sync>) -> Result<FineTune> {
        let b = base(&input.base)?;
        let mut config = input.config;
        if config.tasks.is_empty() {
            return Err(Error::invalid("add at least one question"));
        }
        if config.input_columns.is_empty() {
            return Err(Error::invalid("pick at least one input column"));
        }
        if let Some(other) = held_out_by(&self.store, &config.dataset_id)? {
            return Err(Error::invalid(format!("this dataset holds the rows held out to test “{}”; pick another one", other.name)));
        }
        let dataset = self.store.get_dataset(&config.dataset_id)?;
        let source = input.source_experiment_id.as_deref().and_then(|id| self.store.get_experiment(id).ok());
        // Earlier fine-tunes can be compared against too.
        config.models.dedup();
        config.sample_size = None;
        let name = match input.name.trim() {
            "" => format!("{} · {}", dataset.name, b.title),
            n => n.to_string(),
        };
        let mut slug = slugify(&name);
        let mut n = 2;
        while self.store.model_name_taken(&format!("{MODEL_PREFIX}{slug}"))? || self.gguf_path(&slug).exists() {
            slug = format!("{}-{n}", slugify(&name));
            n += 1;
        }
        let mut settings = input.settings;
        settings.holdout = settings.holdout.clamp(0.05, 0.5);
        settings.epochs = settings.epochs.clamp(0.25, 10.0);
        let f = FineTune {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            model: format!("{MODEL_PREFIX}{slug}"),
            base: b.id.into(),
            base_title: b.title.into(),
            experiment_id: source.as_ref().map(|e| e.id.clone()),
            experiment_name: source.as_ref().map(|e| e.name.clone()),
            dataset_id: dataset.id.clone(),
            dataset_name: dataset.name.clone(),
            questions: config.tasks.iter().map(|t| t.id.clone()).collect(),
            config: Some(config),
            settings,
            status: Status::Queued,
            progress: Progress::default(),
            split: None,
            before: None,
            after: None,
            eval_experiment_id: None,
            test_dataset_id: None,
            size_bytes: 0,
            train_seconds: None,
            parameters: None,
            trainable_parameters: None,
            has_analysis: false,
            error: None,
            created_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
        };
        self.store.save_finetune(&f)?;
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(f.id.clone(), cancel.clone());
        let this = self.clone();
        let id = f.id.clone();
        tokio::spawn(async move {
            let _turn = this.worker.lock().await;
            let result = if cancel.load(Ordering::Relaxed) { Err(Error::Cancelled) } else { this.run(&id, cancel.clone(), &*on_update).await };
            if let Err(err) = result {
                if let Ok(mut f) = this.store.get_finetune(&id) {
                    let cancelled = cancel.load(Ordering::Relaxed);
                    f.status = if cancelled { Status::Cancelled } else { Status::Failed };
                    f.error = if cancelled { None } else { Some(err.to_string()) };
                    f.progress.stage = None;
                    f.finished_at = Some(now_rfc3339());
                    let _ = this.store.save_finetune(&f);
                    on_update(&f);
                }
            }
            this.cancels.lock().unwrap().remove(&id);
        });
        Ok(f)
    }

    /// A fine-tune is queued or running.
    pub fn trainer_busy(&self) -> bool {
        !self.cancels.lock().unwrap().is_empty()
    }

    pub fn cancel(&self, id: &str) {
        if let Some(c) = self.cancels.lock().unwrap().get(id) {
            c.store(true, Ordering::Relaxed);
        }
    }

    /// Delete a fine-tune, its model file and training files. The held-out evaluation and its
    /// dataset stay (they are ordinary evaluations and datasets).
    pub async fn delete(&self, id: &str) -> Result<()> {
        let f = self.store.get_finetune(id)?;
        if f.status.is_active() {
            return Err(Error::invalid("cancel the fine-tune before deleting it"));
        }
        let gguf = self.gguf_path(&f.model);
        if gguf.exists() {
            tokio::fs::remove_file(&gguf).await?;
            self.server.restart().await;
        }
        let _ = tokio::fs::remove_dir_all(self.job_dir(id)).await;
        self.store.delete_finetune_row(id)
    }

    /// The last lines of the trainer's output.
    pub fn log_tail(&self, id: &str, lines: usize) -> String {
        let text = std::fs::read_to_string(self.job_dir(id).join("train.log")).unwrap_or_default();
        let all: Vec<&str> = text.lines().collect();
        all[all.len().saturating_sub(lines)..].join("\n")
    }

    pub fn analysis(&self, id: &str) -> Result<Analysis> {
        let path = self.job_dir(id).join("analysis.json");
        if !path.is_file() {
            return Ok(Analysis::default());
        }
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }

    pub fn job_folder(&self, id: &str) -> PathBuf {
        self.job_dir(id)
    }

    async fn run(&self, id: &str, cancel: Arc<AtomicBool>, on_update: &(dyn Fn(&FineTune) + Send + Sync)) -> Result<()> {
        let mut f = self.store.get_finetune(id)?;
        let save = |f: &FineTune| -> Result<()> {
            self.store.save_finetune(f)?;
            on_update(f);
            Ok(())
        };
        if !self.trainer.status().installed {
            return Err(Error::invalid("The trainer isn't set up yet."));
        }
        let b = base(&f.base)?;
        f.status = Status::Preparing;
        f.started_at = Some(now_rfc3339());
        save(&f)?;

        // Data: split, write train / calibration records, keep the test rows as a dataset.
        let config = match (&f.config, &f.experiment_id) {
            (Some(c), _) => c.clone(),
            (None, Some(e)) => self.store.get_experiment(e)?.config,
            (None, None) => return Err(Error::invalid("this fine-tune has no setup")),
        };
        let rows = labelled_rows(&self.store, &config)?;
        let strata: Vec<String> = rows.iter().map(|(_, r)| stratum(&config, r)).collect();
        let (train, calib, test) = split_rows(&strata, f.settings.holdout, f.settings.seed);
        if train.len() < 20 || calib.is_empty() {
            return Err(Error::invalid(format!("not enough labelled rows: {} for training, {} for calibration", train.len(), calib.len())));
        }
        let dir = self.job_dir(id);
        tokio::fs::create_dir_all(&dir).await?;
        let mut records = 0;
        for (name, part) in [("train.jsonl", &train), ("calib.jsonl", &calib)] {
            let mut text = String::new();
            for &i in part.iter() {
                for r in records_of_row(&config, &rows[i].1)? {
                    text.push_str(&serde_json::to_string(&r)?);
                    text.push('\n');
                    if name == "train.jsonl" {
                        records += 1;
                    }
                }
            }
            tokio::fs::write(dir.join(name), text).await?;
        }
        let source = self.store.get_dataset(&config.dataset_id)?;
        let test_rows: Vec<Row> = test.iter().map(|&i| rows[i].1.clone()).collect();
        let test_dataset = self.store.insert_dataset(
            &format!("{} · held out for {}", source.name, f.name),
            Some(&format!("fine-tune {}", f.model)),
            &ParsedDataset { columns: source.columns.clone(), rows: test_rows },
        )?;
        f.test_dataset_id = Some(test_dataset.id.clone());
        f.split = Some(Split { labelled: rows.len(), train: train.len(), calibration: calib.len(), test: test.len(), records });

        // Baseline: the comparison models answer the held-out rows before training. The same
        // evaluation gets the fine-tune afterwards, so before and after sit side by side.
        let eval_config = ExperimentConfig {
            name: format!("{}: held-out test", f.name),
            dataset_id: test_dataset.id.clone(),
            sample_size: None,
            ..config.clone()
        };
        if !eval_config.models.is_empty() {
            f.status = Status::Baseline;
            let eval_id = runner::create(&self.store, &eval_config)?;
            f.eval_experiment_id = Some(eval_id.clone());
            save(&f)?;
            match runner::execute(self.store.clone(), self.decider.clone(), eval_id.clone(), cancel.clone(), |_| {}).await {
                _ if cancel.load(Ordering::Relaxed) => return Err(Error::Cancelled),
                Ok(_) => {}
                Err(e) => {
                    let _ = self.store.set_experiment_status(&eval_id, ExperimentStatus::Failed, Some(&e.to_string()));
                    f.error = Some(format!("The comparison models could not be evaluated: {e}"));
                }
            }
        }
        f.status = Status::Training;
        f.progress.stage = Some("loading".into());
        save(&f)?;

        // Train.
        tokio::fs::write(self.trainer.script(), TRAIN_SCRIPT).await?;
        let out = dir.join("run");
        let mut cmd = Command::new(self.trainer.python());
        cmd.arg(self.trainer.script())
            .args(["--base", b.repo, "--layout", b.layout()])
            .arg("--train")
            .arg(dir.join("train.jsonl"))
            .arg("--calib")
            .arg(dir.join("calib.jsonl"))
            .arg("--out")
            .arg(&out)
            .args(["--epochs", &f.settings.epochs.to_string()])
            .args(["--lr", &f.settings.learning_rate.to_string()])
            .args(["--lora-r", &f.settings.lora_rank.to_string()])
            .args(["--max-seq-length", &f.settings.max_length.to_string()])
            .args(["--seed", &f.settings.seed.to_string()])
            .args(["--gguf", "q8_0", "--events"])
            .env("UNSLOTH_LLAMA_CPP_SCRIPTS_DIR", self.trainer.llama_src())
            .env("PYTHONUNBUFFERED", "1")
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("TOKENIZERS_PARALLELISM", "false")
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(dir.join("train.log"))?)
            .kill_on_drop(true);
        if let Some(s) = b.subfolder {
            cmd.args(["--subfolder", s]);
        }
        if let Some(h) = b.head_learning_rate {
            cmd.args(["--head-lr", &h.to_string()]);
        }
        if b.load_in_4bit {
            cmd.arg("--load-in-4bit");
        }
        let mut child = cmd.spawn()?;
        let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut stdout_log = Vec::new();
        let mut analysis = Analysis::default();
        let mut last_save = std::time::Instant::now();
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Some(line) = line? else { break };
                    let Some(event) = line.strip_prefix("@@").and_then(|j| serde_json::from_str::<Value>(j).ok()) else {
                        stdout_log.push(line);
                        continue;
                    };
                    if matches!(event["event"].as_str(), Some("gold" | "analysis")) {
                        analysis.apply(&event);
                        tokio::fs::write(dir.join("analysis.json"), serde_json::to_vec(&analysis)?).await?;
                        f.has_analysis = true;
                    }
                    let important = apply_event(&mut f, &event);
                    if important || last_save.elapsed() > Duration::from_millis(500) {
                        save(&f)?;
                        last_save = std::time::Instant::now();
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if cancel.load(Ordering::Relaxed) {
                        let _ = child.kill().await;
                        return Err(Error::Cancelled);
                    }
                }
            }
        }
        let status = child.wait().await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        if !status.success() {
            let log = self.log_tail(id, 40);
            let last = log.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
            return Err(Error::invalid(format!("training failed ({status}): {last}")));
        }

        // Install the model.
        let gguf = out.join("gguf").join("model-Q8_0.gguf");
        if !gguf.is_file() {
            return Err(Error::invalid("training finished but no GGUF was exported"));
        }
        let target = self.gguf_path(&f.model);
        tokio::fs::create_dir_all(self.server.models_dir()).await?;
        tokio::fs::rename(&gguf, &target).await?;
        let _ = tokio::fs::remove_dir_all(out.join("gguf")).await;
        f.size_bytes = tokio::fs::metadata(&target).await?.len();
        tokio::fs::write(dir.join("NOTICE.txt"), notice(&f, b)).await?;
        self.server.restart().await;

        // Test: the fine-tune answers the same held-out rows, in the baseline's evaluation.
        f.status = Status::Evaluating;
        f.progress.stage = None;
        let eval_id = match &f.eval_experiment_id {
            Some(id) => {
                let mut c = self.store.get_experiment(id)?.config;
                c.models.insert(0, f.model.clone());
                self.store.update_experiment_config(id, &c)?;
                id.clone()
            }
            None => runner::create(&self.store, &ExperimentConfig { models: vec![f.model.clone()], ..eval_config })?,
        };
        f.eval_experiment_id = Some(eval_id.clone());
        save(&f)?;
        let eval_cancel = Arc::new(AtomicBool::new(false));
        let status = runner::execute(self.store.clone(), self.decider.clone(), eval_id.clone(), eval_cancel, |_| {}).await;
        match status {
            Ok(ExperimentStatus::Completed) => {}
            Ok(other) => f.error = Some(format!("The held-out evaluation ended {other:?}.")),
            Err(e) => {
                let _ = self.store.set_experiment_status(&eval_id, ExperimentStatus::Failed, Some(&e.to_string()));
                f.error = Some(format!("The held-out evaluation failed: {e}"));
            }
        }
        f.status = Status::Ready;
        f.finished_at = Some(now_rfc3339());
        save(&f)?;
        Ok(())
    }
}

/// The licence notice kept with a fine-tune: it is a derivative of its base model's weights.
fn notice(f: &FineTune, b: &Base) -> String {
    format!(
        "{model} ({name})\n\n\
         A fine-tune of {title} ({repo}{sub}), made with ClassifAI Studio on {date}.\n\
         Its weights are derived from {title}, licensed under the {license} licence:\n\
         https://huggingface.co/{repo}\n\n\
         If you share this model, include this notice and the base model's licence.\n\n\
         Trained with Unsloth (https://github.com/unslothai/unsloth; decision-model code AGPL-3.0),\n\
         run as a separate program; exported and served with llama.cpp (MIT).\n",
        model = f.model,
        name = f.name,
        title = b.title,
        repo = b.repo,
        sub = b.subfolder.map(|s| format!(", {s}")).unwrap_or_default(),
        date = f.created_at.get(..10).unwrap_or(&f.created_at),
        license = b.license,
    )
}

fn records_of_row(config: &ExperimentConfig, row: &Row) -> Result<Vec<Value>> {
    records(config, row)
}

/// Fold one trainer event into the job. True for events worth saving right away.
fn apply_event(f: &mut FineTune, event: &Value) -> bool {
    let num = |k: &str| event[k].as_f64().unwrap_or(0.0);
    match event["event"].as_str().unwrap_or("") {
        "stage" => {
            f.progress.stage = event["stage"].as_str().map(String::from);
            true
        }
        "step" => {
            f.progress.step = num("step") as u64;
            f.progress.total_steps = num("total") as u64;
            f.progress.epoch = num("epoch");
            f.progress.elapsed_s = num("elapsed");
            false
        }
        "loss" => {
            f.progress.loss.push((num("step") as u64, num("loss")));
            false
        }
        "scores" => {
            let s = Scores { accuracy: num("accuracy"), ece: num("ece") };
            if event["which"] == "before" {
                f.before = Some(s);
            } else {
                f.after = Some(s);
            }
            true
        }
        "download" => {
            let n = |k: &str| event[k].as_u64().unwrap_or(0);
            let first = f.progress.download.is_none();
            f.progress.download = Some(Download {
                done: n("done"),
                total: n("total"),
                files_done: n("files_done"),
                files: n("files"),
                cached: n("cached"),
                elapsed_s: num("elapsed"),
                error: event["error"].as_str().map(String::from),
            });
            first || n("done") >= n("total")
        }
        "model" => {
            f.parameters = event["parameters"].as_u64();
            f.trainable_parameters = event["trainable"].as_u64();
            f.progress.batch_size = event["batch_size"].as_u64().unwrap_or(0);
            f.progress.records = event["records"].as_u64().unwrap_or(0);
            true
        }
        "analysis" => true,
        "done" => {
            f.train_seconds = event["result"]["train_s"].as_f64();
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{LabelSpec, TaskRoute};

    fn labels(vs: &[&str]) -> Vec<LabelSpec> {
        vs.iter().map(|v| LabelSpec { value: v.to_string(), description: None, aliases: vec![] }).collect()
    }

    fn config() -> ExperimentConfig {
        ExperimentConfig {
            name: "t".into(),
            dataset_id: "d".into(),
            input_columns: vec!["text".into()],
            context: None,
            tasks: vec![
                TaskSpec {
                    id: "team".into(),
                    kind: TaskKind::Choice,
                    instructions: "Which team?".into(),
                    context: None,
                    label_column: "team".into(),
                    labels: labels(&["billing", "tech"]),
                    positive_label: None,
                    threshold: None,
                    when: None,
                },
                TaskSpec {
                    id: "refund".into(),
                    kind: TaskKind::Binary,
                    instructions: "Asks for a refund.".into(),
                    context: None,
                    label_column: "refund".into(),
                    labels: labels(&["yes", "no"]),
                    positive_label: Some("yes".into()),
                    threshold: None,
                    when: Some(TaskRoute { parent: "team".into(), answers: vec!["billing".into()] }),
                },
            ],
            models: vec!["laya:en".into(), "@typesafe/jev".into()],
            sample_size: None,
            concurrency: None,
        }
    }

    fn row(pairs: &[(&str, &str)]) -> Row {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn records_follow_the_runner() {
        let c = config();
        let r = records(&c, &row(&[("text", "charged twice"), ("team", "billing"), ("refund", "yes")])).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["gold"]["team"], "billing");
        assert_eq!(r[0]["questions"]["team"]["type"], "choice");
        assert!(r[0]["questions"].get("refund").is_none(), "follow-ups are asked separately");
        assert_eq!(r[1]["gold"]["refund"], true);
        assert_eq!(r[1]["questions"]["refund"]["type"], "noul");
        assert!(r[1]["state"].as_str().unwrap().contains("Earlier answers:\n- Which team?: billing"));

        // the follow-up's condition isn't met: no record for it
        let r = records(&c, &row(&[("text", "app crashes"), ("team", "tech"), ("refund", "no")])).unwrap();
        assert_eq!(r.len(), 1);
        // unlabelled rows give nothing
        assert!(records(&c, &row(&[("text", "?"), ("team", ""), ("refund", "")])).unwrap().is_empty());
    }

    #[test]
    fn split_is_stratified_and_stable() {
        let strata: Vec<String> = (0..1000).map(|i| if i % 4 == 0 { "rare".into() } else { "common".into() }).collect();
        let (train, calib, test) = split_rows(&strata, 0.2, 7);
        assert_eq!(train.len() + calib.len() + test.len(), 1000);
        assert_eq!(test.len(), 200);
        assert_eq!(test.iter().filter(|&&i| strata[i] == "rare").count(), 50);
        assert!((70..=90).contains(&calib.len()), "{}", calib.len());
        let mut all: Vec<usize> = train.iter().chain(&calib).chain(&test).copied().collect();
        all.sort();
        assert_eq!(all, (0..1000).collect::<Vec<_>>());
        assert_eq!(split_rows(&strata, 0.2, 7), (train, calib, test));
    }

    #[test]
    fn analysis_joins_gold_and_answers() {
        let mut a = Analysis::default();
        a.apply(&json!({"event": "gold", "items": [[0, "q", "methods", "Patients were…"], [1, "q", "results", "Mean fell"]]}));
        a.apply(&json!({"event": "analysis", "which": "before", "items": [[0, "q", "results", 0.4], [1, "q", "results", 0.6]]}));
        a.apply(&json!({"event": "analysis", "which": "after", "items": [[0, "q", "methods", 0.9]]}));
        assert_eq!(a.rows.len(), 2);
        assert_eq!(a.rows[0].before, Some(json!("results")));
        assert_eq!(a.rows[0].after, Some(json!("methods")));
        assert_eq!(a.rows[0].after_p, Some(0.9));
        assert_eq!(a.rows[1].after, None);
    }

    #[test]
    fn download_events() {
        let mut f: FineTune = serde_json::from_value(json!({
            "id": "1", "name": "n", "model": "ft:n", "base": "laya-en", "base_title": "Laya English", "dataset_id": "d", "dataset_name": "d",
            "questions": [], "settings": {"epochs": 1.0, "learning_rate": 0.0001, "lora_rank": 16, "holdout": 0.2, "max_length": 512, "seed": 7},
            "status": "training", "progress": {"stage": "loading", "step": 0, "total_steps": 0, "epoch": 0.0, "elapsed_s": 0.0, "loss": []},
            "split": null, "before": null, "after": null, "eval_experiment_id": null, "test_dataset_id": null, "size_bytes": 0,
            "train_seconds": null, "error": null, "created_at": "now", "started_at": null, "finished_at": null
        }))
        .unwrap();
        assert!(apply_event(&mut f, &json!({"event": "download", "done": 10, "total": 100, "files_done": 1, "files": 5, "cached": 0, "elapsed": 0.4})));
        assert!(!apply_event(&mut f, &json!({"event": "download", "done": 50, "total": 100, "files_done": 3, "files": 5, "cached": 0, "elapsed": 2.0})));
        assert!(apply_event(&mut f, &json!({"event": "download", "done": 100, "total": 100, "files_done": 5, "files": 5, "cached": 0, "elapsed": 4.0})));
        let d = f.progress.download.unwrap();
        assert_eq!((d.done, d.total, d.files_done), (100, 100, 5));
        assert_eq!(base("qwen3.5-0.8b").unwrap().layout(), "lm");
        assert_eq!(base("clef").unwrap().layout(), "clef");
        assert_eq!(base("laya-multilingual").unwrap().layout(), "laya");
    }

    #[test]
    fn notice_names_the_base_and_its_licence() {
        let mut f: FineTune = serde_json::from_value(json!({
            "id": "1", "name": "Sections", "model": "ft:sections", "base": "laya-multilingual", "base_title": "Laya multilingual", "dataset_id": "d", "dataset_name": "d",
            "questions": [], "settings": {"epochs": 1.0, "learning_rate": 0.0001, "lora_rank": 16, "holdout": 0.2, "max_length": 512, "seed": 7},
            "status": "ready", "progress": {"stage": null, "step": 0, "total_steps": 0, "epoch": 0.0, "elapsed_s": 0.0, "loss": []},
            "split": null, "before": null, "after": null, "eval_experiment_id": null, "test_dataset_id": null, "size_bytes": 0,
            "train_seconds": null, "error": null, "created_at": "2026-10-11T23:00:00Z", "started_at": null, "finished_at": null
        }))
        .unwrap();
        f.name = "Sections".into();
        let n = notice(&f, base("laya-multilingual").unwrap());
        assert!(n.starts_with("ft:sections (Sections)"));
        assert!(n.contains("convaiinnovations/laya, multilingual"));
        assert!(n.contains("Apache-2.0 licence"));
        assert!(n.contains("2026-10-11"));
    }

    #[test]
    fn slugs() {
        assert_eq!(slugify("PubMed RCT · Laya English"), "pubmed-rct-laya-english");
        assert_eq!(slugify("  "), "model");
    }

    #[test]
    fn store_round_trip() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.list_finetunes().unwrap().is_empty());
        let f = FineTune {
            id: "1".into(),
            name: "n".into(),
            model: "ft:n".into(),
            base: "laya-en".into(),
            base_title: "Laya English".into(),
            experiment_id: None,
            experiment_name: None,
            config: None,
            dataset_id: "d".into(),
            dataset_name: "d".into(),
            questions: vec![],
            settings: Settings { epochs: 2.0, learning_rate: 1e-4, lora_rank: 16, holdout: 0.2, max_length: 512, seed: 7 },
            status: Status::Ready,
            progress: Progress::default(),
            split: None,
            before: None,
            after: None,
            eval_experiment_id: None,
            test_dataset_id: None,
            size_bytes: 1,
            train_seconds: None,
            parameters: None,
            trainable_parameters: None,
            has_analysis: false,
            error: None,
            created_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
        };
        store.save_finetune(&f).unwrap();
        assert!(store.model_name_taken("ft:n").unwrap());
        assert_eq!(store.get_finetune("1").unwrap().status, Status::Ready);
        store.delete_finetune_row("1").unwrap();
        assert!(store.get_finetune("1").is_err());
    }
}
