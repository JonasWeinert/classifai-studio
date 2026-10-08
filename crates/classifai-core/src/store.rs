//! SQLite persistence. One file (`classifai.db`) holds datasets, their rows, experiments, every
//! prediction, cloud providers with their models and prices, a usage log, label corrections,
//! saved question sets and app settings, so the app and the CLI see the same data. API keys are not
//! stored here (see [`crate::secrets`]).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use indexmap::IndexMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dataset::{ParsedDataset, Row};
use crate::ollaya::Usage;
use crate::providers::{self, CloudModel, Provider, ProviderKind};
pub use crate::task::ExperimentConfig;
use crate::task::LEGACY_TASK_ID;
use crate::{now_rfc3339, Error, Result};

#[derive(Debug, Clone, Serialize)]
pub struct Dataset {
    pub id: String,
    pub name: String,
    pub source: Option<String>,
    pub columns: Vec<String>,
    pub row_count: usize,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValueCount {
    pub value: String,
    pub count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentStatus {
    Pending,
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl ExperimentStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Experiment {
    pub id: String,
    pub name: String,
    pub dataset_id: String,
    pub dataset_name: String,
    pub config: ExperimentConfig,
    pub status: ExperimentStatus,
    pub error: Option<String>,
    /// Row indices evaluated (same for every model).
    pub row_indices: Vec<usize>,
    /// model -> rows answered so far (any question)
    pub progress: IndexMap<String, usize>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prediction {
    pub model: String,
    pub row_idx: usize,
    /// The task (question) id this prediction answers.
    pub question_id: String,
    pub ground_truth: String,
    pub predicted: Option<String>,
    pub confidence: Option<f64>,
    pub top_prob: Option<f64>,
    pub probabilities: Option<IndexMap<String, f64>>,
    pub latency_ms: Option<f64>,
    pub error: Option<String>,
}

/// One request (or a batch of them) to log: who asked, which model, tokens and cost.
#[derive(Debug, Clone)]
pub struct UsageEntry {
    /// `quick`, `experiment` or `test`
    pub source: String,
    pub experiment_id: Option<String>,
    pub model: String,
    pub requests: u64,
    pub usage: Usage,
    pub cost_usd: f64,
}

/// Usage summed per model.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UsageRow {
    pub model: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// A human's verdict on one ground-truth cell. A value equal to the original is a confirmation.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LabelCorrection {
    pub row_idx: usize,
    pub column: String,
    /// The raw cell value when the correction was made.
    pub original: String,
    pub value: String,
    pub note: Option<String>,
    pub at: String,
}

impl LabelCorrection {
    pub fn is_confirmation(&self) -> bool {
        self.value.trim() == self.original.trim()
    }
}

/// (row, column) -> correction, for one dataset.
pub type Corrections = HashMap<(usize, String), LabelCorrection>;

/// Replace corrected cells with their corrected value, so ground truth read from these rows
/// reflects human review. Rows and columns without a correction are left alone.
pub fn apply_corrections(rows: &mut [(usize, Row)], corrections: &Corrections) {
    if corrections.is_empty() {
        return;
    }
    for (idx, row) in rows.iter_mut() {
        for (col, cell) in row.iter_mut() {
            if let Some(c) = corrections.get(&(*idx, col.clone())) {
                *cell = c.value.clone();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuestionSetSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Latest version, from 1.
    pub version: u32,
    pub question_count: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuestionSet {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: u32,
    pub updated_at: String,
    /// Owned by the frontend (`{ context, questions: [...] }`); stored as given.
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuestionSetInput {
    /// None (or unknown) creates a new set; its id is a unique slug of the name.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub monthly_budget_usd: Option<f64>,
    /// Refuse cloud requests once the monthly budget is used up.
    #[serde(default)]
    pub budget_hard_stop: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BudgetStatus {
    pub month_spend_usd: f64,
    pub budget_usd: Option<f64>,
    /// spend / budget; None without a budget.
    pub ratio: Option<f64>,
    pub exceeded: bool,
}

pub struct Store {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT,
    columns TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_rows (
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (dataset_id, idx)
);
CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    row_indices TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
"#;

/// Bumped whenever the schema changes; see [`migrate`].
const SCHEMA_VERSION: i64 = 4;

/// One row per (experiment, model, row, question).
const PREDICTIONS_TABLE: &str = r#"
CREATE TABLE predictions (
    experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    row_idx INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    ground_truth TEXT NOT NULL,
    predicted TEXT,
    confidence REAL,
    top_prob REAL,
    probabilities TEXT,
    latency_ms REAL,
    error TEXT,
    PRIMARY KEY (experiment_id, model, row_idx, question_id)
);
"#;

/// v3: cloud providers, their models (prices per million tokens) and the usage log. Usage rows
/// outlive deleted experiments and providers, so they keep no foreign keys.
const CLOUD_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    account_id TEXT,
    has_key INTEGER NOT NULL DEFAULT 0,
    key_hint TEXT,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_models (
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    input_price_per_mtok REAL NOT NULL,
    output_price_per_mtok REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_id, model)
);
CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    experiment_id TEXT,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_log_experiment ON usage_log (experiment_id);
CREATE INDEX IF NOT EXISTS usage_log_at ON usage_log (at);
"#;

/// v4: human label corrections, versioned question sets, key/value settings.
const V4_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS label_corrections (
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    row_idx INTEGER NOT NULL,
    column_name TEXT NOT NULL,
    original TEXT NOT NULL,
    value TEXT NOT NULL,
    note TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (dataset_id, row_idx, column_name)
);
CREATE TABLE IF NOT EXISTS question_sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_set_versions (
    set_id TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (set_id, version)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS predictions_model ON predictions (model);
"#;

/// Bring the schema to [`SCHEMA_VERSION`]. Idempotent.
///
/// v0/v1 → v2: predictions gain `question_id`; existing rows answered the single question of
/// that time, so they get [`LEGACY_TASK_ID`].
/// v2 → v3: [`CLOUD_TABLES`].
/// v3 → v4: [`V4_TABLES`].
fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    let tx = conn.transaction()?;
    if version < 2 {
        migrate_v2(&tx)?;
    }
    if version < 3 {
        tx.execute_batch(CLOUD_TABLES)?;
    }
    if version < 4 {
        tx.execute_batch(V4_TABLES)?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    tx.commit()?;
    Ok(())
}

fn migrate_v2(tx: &rusqlite::Transaction) -> Result<()> {
    let has_table: bool = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'predictions'",
        [],
        |r| Ok(r.get::<_, i64>(0)? > 0),
    )?;
    let has_question: bool = tx.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('predictions') WHERE name = 'question_id'",
        [],
        |r| Ok(r.get::<_, i64>(0)? > 0),
    )?;
    if !has_table {
        tx.execute_batch(PREDICTIONS_TABLE)?;
    } else if !has_question {
        tx.execute_batch(&format!(
            "ALTER TABLE predictions RENAME TO predictions_v1;
             {PREDICTIONS_TABLE}
             INSERT INTO predictions
                 (experiment_id, model, row_idx, question_id, ground_truth, predicted, confidence, top_prob, probabilities, latency_ms, error)
             SELECT experiment_id, model, row_idx, '{LEGACY_TASK_ID}', ground_truth, predicted, confidence, top_prob, probabilities, latency_ms, error
             FROM predictions_v1;
             DROP TABLE predictions_v1;"
        ))?;
    }
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut conn = Connection::open(path)?;
        migrate(&mut conn)?;
        let store = Self { conn: Mutex::new(conn) };
        store.recover_interrupted()?;
        store.seed_builtin_providers()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        migrate(&mut conn)?;
        let store = Self { conn: Mutex::new(conn) };
        store.seed_builtin_providers()?;
        Ok(store)
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Experiments that were running when the app quit are marked cancelled.
    fn recover_interrupted(&self) -> Result<()> {
        self.conn().execute(
            "UPDATE experiments SET status = 'cancelled', error = 'Interrupted: the app was closed while running'
             WHERE status IN ('running', 'pending')",
            [],
        )?;
        Ok(())
    }

    // ---- datasets ------------------------------------------------------------------------

    pub fn insert_dataset(&self, name: &str, source: Option<&str>, data: &ParsedDataset) -> Result<Dataset> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO datasets (id, name, source, columns, row_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, source, serde_json::to_string(&data.columns)?, data.rows.len(), created_at],
        )?;
        {
            let mut stmt = tx.prepare("INSERT INTO dataset_rows (dataset_id, idx, data) VALUES (?1, ?2, ?3)")?;
            for (i, row) in data.rows.iter().enumerate() {
                stmt.execute(params![id, i, serde_json::to_string(row)?])?;
            }
        }
        tx.commit()?;
        Ok(Dataset {
            id,
            name: name.into(),
            source: source.map(Into::into),
            columns: data.columns.clone(),
            row_count: data.rows.len(),
            created_at,
        })
    }

    fn map_dataset(r: &rusqlite::Row) -> rusqlite::Result<Dataset> {
        let cols: String = r.get(3)?;
        Ok(Dataset {
            id: r.get(0)?,
            name: r.get(1)?,
            source: r.get(2)?,
            columns: serde_json::from_str(&cols).unwrap_or_default(),
            row_count: r.get::<_, i64>(4)? as usize,
            created_at: r.get(5)?,
        })
    }

    pub fn list_datasets(&self) -> Result<Vec<Dataset>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, source, columns, row_count, created_at FROM datasets ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], Self::map_dataset)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn get_dataset(&self, id: &str) -> Result<Dataset> {
        self.conn()
            .query_row(
                "SELECT id, name, source, columns, row_count, created_at FROM datasets WHERE id = ?1",
                [id],
                Self::map_dataset,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("dataset {id}")))
    }

    pub fn rename_dataset(&self, id: &str, name: &str) -> Result<()> {
        self.conn().execute("UPDATE datasets SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    pub fn delete_dataset(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM datasets WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn dataset_rows(&self, id: &str, offset: usize, limit: usize) -> Result<Vec<(usize, Row)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT idx, data FROM dataset_rows WHERE dataset_id = ?1 ORDER BY idx LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt
            .query_map(params![id, limit as i64, offset as i64], |r| {
                Ok((r.get::<_, i64>(0)? as usize, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(i, d)| Ok((i, serde_json::from_str(&d)?)))
            .collect()
    }

    pub fn dataset_rows_by_index(&self, id: &str, indices: &[usize]) -> Result<Vec<(usize, Row)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT data FROM dataset_rows WHERE dataset_id = ?1 AND idx = ?2")?;
        indices
            .iter()
            .map(|&i| {
                let d: String = stmt.query_row(params![id, i as i64], |r| r.get(0))?;
                Ok((i, serde_json::from_str(&d)?))
            })
            .collect()
    }

    /// Distinct values of one column, most frequent first (trimmed). Capped at `limit` values.
    pub fn value_counts(&self, id: &str, column: &str, limit: usize) -> Result<Vec<ValueCount>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT TRIM(COALESCE(json_extract(data, '$.' || json_quote(?2)), '')) AS v, COUNT(*) AS n
             FROM dataset_rows WHERE dataset_id = ?1 GROUP BY v ORDER BY n DESC, v LIMIT ?3",
        )?;
        let out = stmt
            .query_map(params![id, column, limit as i64], |r| {
                Ok(ValueCount { value: r.get(0)?, count: r.get::<_, i64>(1)? as usize })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }

    // ---- experiments ---------------------------------------------------------------------

    pub fn create_experiment(&self, config: &ExperimentConfig, row_indices: &[usize]) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn().execute(
            "INSERT INTO experiments (id, dataset_id, name, config, status, row_indices, created_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)",
            params![
                id,
                config.dataset_id,
                config.name,
                serde_json::to_string(config)?,
                serde_json::to_string(row_indices)?,
                now_rfc3339()
            ],
        )?;
        Ok(id)
    }

    pub fn set_experiment_status(&self, id: &str, status: ExperimentStatus, error: Option<&str>) -> Result<()> {
        let finished = matches!(
            status,
            ExperimentStatus::Completed | ExperimentStatus::Cancelled | ExperimentStatus::Failed
        )
        .then(now_rfc3339);
        self.conn().execute(
            "UPDATE experiments SET status = ?2, error = ?3, finished_at = ?4 WHERE id = ?1",
            params![id, status.as_str(), error, finished],
        )?;
        Ok(())
    }

    pub fn list_experiments(&self, dataset_id: Option<&str>) -> Result<Vec<Experiment>> {
        let ids: Vec<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT id FROM experiments WHERE (?1 IS NULL OR dataset_id = ?1) ORDER BY created_at DESC",
            )?;
            let ids = stmt.query_map([dataset_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            ids
        };
        ids.iter().map(|id| self.get_experiment(id)).collect()
    }

    pub fn get_experiment(&self, id: &str) -> Result<Experiment> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT e.id, e.name, e.dataset_id, d.name, e.config, e.status, e.error, e.row_indices, e.created_at, e.finished_at
                 FROM experiments e JOIN datasets d ON d.id = e.dataset_id WHERE e.id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                        r.get::<_, Option<String>>(9)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("experiment {id}")))?;
        let config: ExperimentConfig = serde_json::from_str(&row.4)?;
        let mut progress: IndexMap<String, usize> = config.models.iter().map(|m| (m.clone(), 0)).collect();
        let mut stmt =
            conn.prepare("SELECT model, COUNT(DISTINCT row_idx) FROM predictions WHERE experiment_id = ?1 GROUP BY model")?;
        for r in stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))? {
            let (m, n) = r?;
            progress.insert(m, n);
        }
        Ok(Experiment {
            id: row.0,
            name: row.1,
            dataset_id: row.2,
            dataset_name: row.3,
            config,
            status: ExperimentStatus::parse(&row.5),
            error: row.6,
            row_indices: serde_json::from_str(&row.7)?,
            progress,
            created_at: row.8,
            finished_at: row.9,
        })
    }

    pub fn delete_experiment(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM experiments WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn insert_prediction(&self, experiment_id: &str, p: &Prediction) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO predictions
             (experiment_id, model, row_idx, question_id, ground_truth, predicted, confidence, top_prob, probabilities, latency_ms, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                experiment_id,
                p.model,
                p.row_idx as i64,
                p.question_id,
                p.ground_truth,
                p.predicted,
                p.confidence,
                p.top_prob,
                p.probabilities.as_ref().map(serde_json::to_string).transpose()?,
                p.latency_ms,
                p.error,
            ],
        )?;
        Ok(())
    }

    /// Every prediction of an experiment, all questions.
    pub fn predictions(&self, experiment_id: &str) -> Result<Vec<Prediction>> {
        self.query_predictions(experiment_id, None)
    }

    /// Predictions for one question of an experiment.
    pub fn predictions_for(&self, experiment_id: &str, question_id: &str) -> Result<Vec<Prediction>> {
        self.query_predictions(experiment_id, Some(question_id))
    }

    fn query_predictions(&self, experiment_id: &str, question_id: Option<&str>) -> Result<Vec<Prediction>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT model, row_idx, question_id, ground_truth, predicted, confidence, top_prob, probabilities, latency_ms, error
             FROM predictions WHERE experiment_id = ?1 AND (?2 IS NULL OR question_id = ?2)
             ORDER BY model, row_idx, question_id",
        )?;
        let out = stmt
            .query_map(params![experiment_id, question_id], |r| {
                let probs: Option<String> = r.get(7)?;
                Ok(Prediction {
                    model: r.get(0)?,
                    row_idx: r.get::<_, i64>(1)? as usize,
                    question_id: r.get(2)?,
                    ground_truth: r.get(3)?,
                    predicted: r.get(4)?,
                    confidence: r.get(5)?,
                    top_prob: r.get(6)?,
                    probabilities: probs.and_then(|s| serde_json::from_str(&s).ok()),
                    latency_ms: r.get(8)?,
                    error: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }

    // ---- cloud providers -----------------------------------------------------------------

    /// Adds the built-in providers and models that are missing. Rows that exist are left alone,
    /// so prices and switches the user edited survive.
    pub fn seed_builtin_providers(&self) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let now = now_rfc3339();
        for p in providers::builtin_providers() {
            tx.execute(
                "INSERT OR IGNORE INTO providers (id, kind, name, base_url, account_id, has_key, key_hint, builtin, created_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, 0, NULL, 1, ?4)",
                params![p.id, p.kind.as_str(), p.name, now],
            )?;
        }
        for m in providers::builtin_models() {
            tx.execute(
                "INSERT OR IGNORE INTO cloud_models
                 (provider_id, model, display_name, description, input_price_per_mtok, output_price_per_mtok, enabled, builtin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1)",
                params![m.provider_id, m.model, m.display_name, m.description, m.input_price_per_mtok, m.output_price_per_mtok],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn map_provider(r: &rusqlite::Row) -> rusqlite::Result<Provider> {
        let kind: String = r.get(1)?;
        Ok(Provider {
            id: r.get(0)?,
            kind: ProviderKind::parse(&kind).unwrap_or(ProviderKind::Custom),
            name: r.get(2)?,
            base_url: r.get(3)?,
            account_id: r.get(4)?,
            has_key: r.get(5)?,
            key_hint: r.get(6)?,
            builtin: r.get(7)?,
        })
    }

    const PROVIDER_COLUMNS: &'static str = "id, kind, name, base_url, account_id, has_key, key_hint, builtin";

    /// Built-in providers first, then in the order they were added.
    pub fn list_providers(&self) -> Result<Vec<Provider>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare(&format!("SELECT {} FROM providers ORDER BY builtin DESC, rowid", Self::PROVIDER_COLUMNS))?;
        let rows = stmt.query_map([], Self::map_provider)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn get_provider(&self, id: &str) -> Result<Provider> {
        self.conn()
            .query_row(&format!("SELECT {} FROM providers WHERE id = ?1", Self::PROVIDER_COLUMNS), [id], Self::map_provider)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("provider {id}")))
    }

    pub fn insert_provider(&self, p: &Provider) -> Result<()> {
        self.conn().execute(
            "INSERT INTO providers (id, kind, name, base_url, account_id, has_key, key_hint, builtin, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![p.id, p.kind.as_str(), p.name, p.base_url, p.account_id, p.has_key, p.key_hint, p.builtin, now_rfc3339()],
        )?;
        Ok(())
    }

    /// Name, base URL and account id; the key state has its own setter.
    pub fn update_provider(&self, p: &Provider) -> Result<()> {
        self.conn().execute(
            "UPDATE providers SET name = ?2, base_url = ?3, account_id = ?4 WHERE id = ?1",
            params![p.id, p.name, p.base_url, p.account_id],
        )?;
        Ok(())
    }

    pub fn set_provider_key_state(&self, id: &str, has_key: bool, key_hint: Option<&str>) -> Result<()> {
        self.conn().execute(
            "UPDATE providers SET has_key = ?2, key_hint = ?3 WHERE id = ?1",
            params![id, has_key, key_hint],
        )?;
        Ok(())
    }

    /// Removes the provider and its models.
    pub fn delete_provider(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM providers WHERE id = ?1", [id])?;
        Ok(())
    }

    fn map_cloud_model(r: &rusqlite::Row) -> rusqlite::Result<CloudModel> {
        Ok(CloudModel {
            provider_id: r.get(0)?,
            model: r.get(1)?,
            display_name: r.get(2)?,
            description: r.get(3)?,
            input_price_per_mtok: r.get(4)?,
            output_price_per_mtok: r.get(5)?,
            enabled: r.get(6)?,
            builtin: r.get(7)?,
        })
    }

    const MODEL_COLUMNS: &'static str =
        "provider_id, model, display_name, description, input_price_per_mtok, output_price_per_mtok, enabled, builtin";

    /// Models of one provider (or all), in the order they were added.
    pub fn list_cloud_models(&self, provider_id: Option<&str>) -> Result<Vec<CloudModel>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM cloud_models WHERE (?1 IS NULL OR provider_id = ?1) ORDER BY rowid",
            Self::MODEL_COLUMNS
        ))?;
        let rows = stmt.query_map([provider_id], Self::map_cloud_model)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn get_cloud_model(&self, provider_id: &str, model: &str) -> Result<Option<CloudModel>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {} FROM cloud_models WHERE provider_id = ?1 AND model = ?2", Self::MODEL_COLUMNS),
                [provider_id, model],
                Self::map_cloud_model,
            )
            .optional()?)
    }

    pub fn upsert_cloud_model(&self, m: &CloudModel) -> Result<()> {
        self.conn().execute(
            "INSERT INTO cloud_models
             (provider_id, model, display_name, description, input_price_per_mtok, output_price_per_mtok, enabled, builtin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (provider_id, model) DO UPDATE SET
                display_name = excluded.display_name, description = excluded.description,
                input_price_per_mtok = excluded.input_price_per_mtok, output_price_per_mtok = excluded.output_price_per_mtok,
                enabled = excluded.enabled, builtin = excluded.builtin",
            params![
                m.provider_id,
                m.model,
                m.display_name,
                m.description,
                m.input_price_per_mtok,
                m.output_price_per_mtok,
                m.enabled,
                m.builtin
            ],
        )?;
        Ok(())
    }

    pub fn delete_cloud_model(&self, provider_id: &str, model: &str) -> Result<()> {
        self.conn().execute("DELETE FROM cloud_models WHERE provider_id = ?1 AND model = ?2", [provider_id, model])?;
        Ok(())
    }

    // ---- usage ---------------------------------------------------------------------------

    pub fn log_usage(&self, e: &UsageEntry) -> Result<()> {
        self.conn().execute(
            "INSERT INTO usage_log (at, source, experiment_id, model, requests, input_tokens, output_tokens, cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                now_rfc3339(),
                e.source,
                e.experiment_id,
                e.model,
                e.requests as i64,
                e.usage.input_tokens as i64,
                e.usage.output_tokens as i64,
                e.cost_usd
            ],
        )?;
        Ok(())
    }

    /// Usage per model since an RFC 3339 time (all time when None), most expensive first.
    pub fn usage_summary(&self, since: Option<&str>) -> Result<Vec<UsageRow>> {
        self.query_usage("WHERE (?1 IS NULL OR at >= ?1)", since)
    }

    /// Usage per model of one experiment, most expensive first.
    pub fn experiment_usage(&self, experiment_id: &str) -> Result<Vec<UsageRow>> {
        self.query_usage("WHERE experiment_id = ?1", Some(experiment_id))
    }

    fn query_usage(&self, filter: &str, arg: Option<&str>) -> Result<Vec<UsageRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT model, SUM(requests), SUM(input_tokens), SUM(output_tokens), SUM(cost_usd) AS cost
             FROM usage_log {filter} GROUP BY model ORDER BY cost DESC, SUM(requests) DESC, model"
        ))?;
        let rows = stmt
            .query_map([arg], |r| {
                Ok(UsageRow {
                    model: r.get(0)?,
                    requests: r.get::<_, i64>(1)? as u64,
                    input_tokens: r.get::<_, i64>(2)? as u64,
                    output_tokens: r.get::<_, i64>(3)? as u64,
                    cost_usd: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
}

/// Start of the current month in local time, as an RFC 3339 UTC string comparable with `usage_log.at`.
pub fn local_month_start_utc() -> String {
    use chrono::{Datelike, Local, TimeZone};
    let now = Local::now();
    let start = Local
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .earliest()
        .unwrap_or(now);
    start.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Escape `%`, `_` and `\` for a `LIKE ... ESCAPE '\'` pattern.
fn like_pattern(term: &str) -> String {
    let mut out = String::from("%");
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// Numbers compare numerically and come before text; text compares case-insensitively.
fn compare_values(a: &str, b: &str) -> Ordering {
    let num = |s: &str| s.trim().parse::<f64>().ok().filter(|v| v.is_finite());
    match (num(a), num(b)) {
        (Some(x), Some(y)) => x.total_cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)),
    }
}

/// Sort `(row, cell)` pairs by cell: numeric-aware, empty cells last in either direction, ties by row.
fn sort_by_cell(items: &mut [(usize, String)], desc: bool) {
    items.sort_by(|(ia, a), (ib, b)| {
        let ord = match (a.trim().is_empty(), b.trim().is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                let o = compare_values(a, b);
                if desc { o.reverse() } else { o }
            }
        };
        ord.then(ia.cmp(ib))
    });
}

fn slug_or(name: &str, fallback: &str) -> String {
    if name.chars().any(|c| c.is_ascii_alphanumeric()) {
        providers::slugify(name)
    } else {
        fallback.to_string()
    }
}

fn question_count(payload: &Value) -> usize {
    payload.get("questions").and_then(Value::as_array).map_or(0, Vec::len)
}

impl Store {
    // ---- dataset browsing ----------------------------------------------------------------

    /// A page of rows, optionally filtered by a case-insensitive substring of any cell and sorted
    /// by one column (numeric-aware, empty cells last). Returns the page and the matching count.
    pub fn dataset_rows_page(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
        search: Option<&str>,
        sort_column: Option<&str>,
        sort_desc: bool,
    ) -> Result<(Vec<(usize, Row)>, usize)> {
        let search = search.map(str::trim).filter(|s| !s.is_empty());
        let sort_column = sort_column.filter(|c| !c.is_empty());
        // SQLite's LIKE only folds ASCII case; other terms are matched in Rust.
        if let Some(term) = search.filter(|t| !t.is_ascii()) {
            let needle = term.to_lowercase();
            let mut rows: Vec<(usize, Row)> = self
                .dataset_rows(id, 0, i64::MAX as usize)?
                .into_iter()
                .filter(|(_, r)| r.values().any(|v| v.to_lowercase().contains(&needle)))
                .collect();
            let total = rows.len();
            if let Some(col) = sort_column {
                let mut keys: Vec<(usize, String)> =
                    rows.iter().enumerate().map(|(i, (_, r))| (i, r.get(col).cloned().unwrap_or_default())).collect();
                sort_by_cell(&mut keys, sort_desc);
                let mut slots: Vec<Option<(usize, Row)>> = rows.into_iter().map(Some).collect();
                rows = keys.into_iter().filter_map(|(i, _)| slots[i].take()).collect();
            }
            return Ok((rows.into_iter().skip(offset).take(limit).collect(), total));
        }

        let pattern = search.map(like_pattern);
        const FILTER: &str = "dataset_id = ?1 AND (?2 IS NULL OR EXISTS
            (SELECT 1 FROM json_each(dataset_rows.data) WHERE CAST(value AS TEXT) LIKE ?2 ESCAPE '\\'))";
        let Some(col) = sort_column else {
            let conn = self.conn();
            let total: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM dataset_rows WHERE {FILTER}"),
                params![id, pattern],
                |r| r.get(0),
            )?;
            let mut stmt = conn.prepare(&format!(
                "SELECT idx, data FROM dataset_rows WHERE {FILTER} ORDER BY idx LIMIT ?3 OFFSET ?4"
            ))?;
            let raw = stmt
                .query_map(params![id, pattern, limit as i64, offset as i64], |r| {
                    Ok((r.get::<_, i64>(0)? as usize, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let rows = raw.into_iter().map(|(i, d)| Ok((i, serde_json::from_str(&d)?))).collect::<Result<_>>()?;
            return Ok((rows, total as usize));
        };
        let mut keys: Vec<(usize, String)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&format!(
                "SELECT idx, CAST(COALESCE(json_extract(data, '$.' || json_quote(?3)), '') AS TEXT)
                 FROM dataset_rows WHERE {FILTER}"
            ))?;
            let keys = stmt
                .query_map(params![id, pattern, col], |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            keys
        };
        let total = keys.len();
        sort_by_cell(&mut keys, sort_desc);
        let page: Vec<usize> = keys.into_iter().skip(offset).take(limit).map(|(i, _)| i).collect();
        Ok((self.dataset_rows_by_index(id, &page)?, total))
    }

    // ---- label corrections ---------------------------------------------------------------

    /// Correct (or, with the original value, confirm) one ground-truth cell.
    pub fn set_label_correction(
        &self,
        dataset_id: &str,
        row_idx: usize,
        column: &str,
        value: &str,
        note: Option<&str>,
    ) -> Result<LabelCorrection> {
        let d = self.get_dataset(dataset_id)?;
        if !d.columns.iter().any(|c| c == column) {
            return Err(Error::invalid(format!("dataset \"{}\" has no column \"{column}\"", d.name)));
        }
        let row = self
            .dataset_rows_by_index(dataset_id, &[row_idx])
            .map_err(|_| Error::NotFound(format!("row {row_idx} of dataset {}", d.name)))?;
        let original = row.into_iter().next().and_then(|(_, r)| r.get(column).cloned()).unwrap_or_default();
        let c = LabelCorrection {
            row_idx,
            column: column.to_string(),
            original,
            value: value.trim().to_string(),
            note: note.map(str::trim).filter(|n| !n.is_empty()).map(String::from),
            at: now_rfc3339(),
        };
        self.conn().execute(
            "INSERT INTO label_corrections (dataset_id, row_idx, column_name, original, value, note, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (dataset_id, row_idx, column_name) DO UPDATE SET
                original = excluded.original, value = excluded.value, note = excluded.note, at = excluded.at",
            params![dataset_id, row_idx as i64, c.column, c.original, c.value, c.note, c.at],
        )?;
        Ok(c)
    }

    pub fn clear_label_correction(&self, dataset_id: &str, row_idx: usize, column: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM label_corrections WHERE dataset_id = ?1 AND row_idx = ?2 AND column_name = ?3",
            params![dataset_id, row_idx as i64, column],
        )?;
        Ok(())
    }

    /// Corrections of one dataset, by row then column.
    pub fn label_corrections(&self, dataset_id: &str) -> Result<Vec<LabelCorrection>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT row_idx, column_name, original, value, note, at FROM label_corrections
             WHERE dataset_id = ?1 ORDER BY row_idx, column_name",
        )?;
        let out = stmt
            .query_map([dataset_id], |r| {
                Ok(LabelCorrection {
                    row_idx: r.get::<_, i64>(0)? as usize,
                    column: r.get(1)?,
                    original: r.get(2)?,
                    value: r.get(3)?,
                    note: r.get(4)?,
                    at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }

    pub fn corrections_map(&self, dataset_id: &str) -> Result<Corrections> {
        Ok(self.label_corrections(dataset_id)?.into_iter().map(|c| ((c.row_idx, c.column.clone()), c)).collect())
    }

    /// Rows with label corrections applied: every row (`indices` None) or the given ones.
    pub fn corrected_rows(&self, dataset_id: &str, indices: Option<&[usize]>) -> Result<Vec<(usize, Row)>> {
        let mut rows = match indices {
            Some(ix) => self.dataset_rows_by_index(dataset_id, ix)?,
            None => self.dataset_rows(dataset_id, 0, i64::MAX as usize)?,
        };
        apply_corrections(&mut rows, &self.corrections_map(dataset_id)?);
        Ok(rows)
    }

    // ---- experiment updates --------------------------------------------------------------

    pub fn update_experiment_config(&self, id: &str, config: &ExperimentConfig) -> Result<()> {
        let n = self
            .conn()
            .execute("UPDATE experiments SET config = ?2 WHERE id = ?1", params![id, serde_json::to_string(config)?])?;
        if n == 0 {
            return Err(Error::NotFound(format!("experiment {id}")));
        }
        Ok(())
    }

    /// Set `predicted` of stored predictions: `(model, row_idx, predicted)` for one question.
    pub fn set_predicted(&self, experiment_id: &str, question_id: &str, updates: &[(String, usize, String)]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE predictions SET predicted = ?5
                 WHERE experiment_id = ?1 AND question_id = ?2 AND model = ?3 AND row_idx = ?4",
            )?;
            for (model, row, predicted) in updates {
                stmt.execute(params![experiment_id, question_id, model, *row as i64, predicted])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Latencies (ms) of every answered prediction of a model, across experiments.
    pub fn model_latencies(&self, model: &str) -> Result<Vec<f64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT latency_ms FROM predictions WHERE model = ?1 AND latency_ms IS NOT NULL AND error IS NULL",
        )?;
        let out = stmt.query_map([model], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }

    // ---- question sets -------------------------------------------------------------------

    /// Latest version of every set, most recently updated first.
    pub fn list_question_sets(&self) -> Result<Vec<QuestionSetSummary>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.description, v.version, v.payload, s.updated_at
             FROM question_sets s JOIN question_set_versions v ON v.set_id = s.id
             WHERE v.version = (SELECT MAX(version) FROM question_set_versions WHERE set_id = s.id)
             ORDER BY s.updated_at DESC, s.id",
        )?;
        let out = stmt
            .query_map([], |r| {
                let payload: String = r.get(4)?;
                Ok(QuestionSetSummary {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    version: r.get(3)?,
                    question_count: question_count(&serde_json::from_str(&payload).unwrap_or(Value::Null)),
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }

    /// One version of a set (the latest when None).
    pub fn get_question_set(&self, id: &str, version: Option<u32>) -> Result<QuestionSet> {
        let conn = self.conn();
        let head = conn
            .query_row(
                "SELECT name, description, updated_at, (SELECT MAX(version) FROM question_set_versions WHERE set_id = ?1)
                 FROM question_sets WHERE id = ?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, u32>(3)?)),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("question set {id}")))?;
        let (name, description, updated_at, latest) = head;
        let version = version.unwrap_or(latest);
        let (payload, created_at): (String, String) = conn
            .query_row(
                "SELECT payload, created_at FROM question_set_versions WHERE set_id = ?1 AND version = ?2",
                params![id, version],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("version {version} of question set {id}")))?;
        Ok(QuestionSet {
            id: id.to_string(),
            name,
            description,
            version,
            updated_at: if version == latest { updated_at } else { created_at },
            payload: serde_json::from_str(&payload)?,
        })
    }

    /// Create a set, or update one: a changed payload adds a version; name and description edits
    /// do not.
    pub fn save_question_set(&self, input: &QuestionSetInput) -> Result<QuestionSetSummary> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(Error::invalid("give the question set a name"));
        }
        if !input.payload.is_object() {
            return Err(Error::invalid("a question set's payload must be a JSON object"));
        }
        let description = input.description.as_deref().map(str::trim).unwrap_or("").to_string();
        let payload = serde_json::to_string(&input.payload)?;
        let now = now_rfc3339();
        let wanted = input.id.as_deref().map(str::trim).filter(|i| !i.is_empty());
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let exists = |id: &str| -> Result<bool> {
            Ok(tx.query_row("SELECT COUNT(*) FROM question_sets WHERE id = ?1", [id], |r| r.get::<_, i64>(0))? > 0)
        };
        let id = match wanted {
            Some(id) if exists(id)? => {
                let latest: (u32, String) = tx.query_row(
                    "SELECT version, payload FROM question_set_versions WHERE set_id = ?1 ORDER BY version DESC LIMIT 1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                let old: Value = serde_json::from_str(&latest.1).unwrap_or(Value::Null);
                if old != input.payload {
                    tx.execute(
                        "INSERT INTO question_set_versions (set_id, version, payload, created_at) VALUES (?1, ?2, ?3, ?4)",
                        params![id, latest.0 + 1, payload, now],
                    )?;
                }
                tx.execute(
                    "UPDATE question_sets SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, name, description, now],
                )?;
                id.to_string()
            }
            other => {
                let base = slug_or(other.unwrap_or(name), "question-set");
                let mut id = base.clone();
                let mut n = 2;
                while exists(&id)? {
                    id = format!("{base}-{n}");
                    n += 1;
                }
                tx.execute(
                    "INSERT INTO question_sets (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, name, description, now],
                )?;
                tx.execute(
                    "INSERT INTO question_set_versions (set_id, version, payload, created_at) VALUES (?1, 1, ?2, ?3)",
                    params![id, payload, now],
                )?;
                id
            }
        };
        tx.commit()?;
        drop(conn);
        self.list_question_sets()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| Error::NotFound(format!("question set {id}")))
    }

    pub fn delete_question_set(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM question_set_versions WHERE set_id = ?1", [id])?;
        conn.execute("DELETE FROM question_sets WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- settings and budget -------------------------------------------------------------

    fn setting<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let v: Option<String> =
            self.conn().query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        Ok(v.and_then(|v| serde_json::from_str(&v).ok()))
    }

    fn put_setting<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn settings(&self) -> Result<AppSettings> {
        Ok(AppSettings {
            monthly_budget_usd: self.setting::<Option<f64>>("monthly_budget_usd")?.flatten(),
            budget_hard_stop: self.setting("budget_hard_stop")?.unwrap_or(false),
        })
    }

    pub fn save_settings(&self, s: &AppSettings) -> Result<AppSettings> {
        if let Some(b) = s.monthly_budget_usd {
            if !b.is_finite() || b < 0.0 {
                return Err(Error::invalid("the monthly budget must be zero or more (USD)"));
            }
        }
        self.put_setting("monthly_budget_usd", &s.monthly_budget_usd)?;
        self.put_setting("budget_hard_stop", &s.budget_hard_stop)?;
        self.settings()
    }

    /// Cost logged since an RFC 3339 time.
    pub fn spend_since(&self, since: &str) -> Result<f64> {
        Ok(self.conn().query_row("SELECT COALESCE(SUM(cost_usd), 0.0) FROM usage_log WHERE at >= ?1", [since], |r| {
            r.get(0)
        })?)
    }

    /// Spend this calendar month (local time) against the monthly budget.
    pub fn budget_status(&self) -> Result<BudgetStatus> {
        let settings = self.settings()?;
        let spend = self.spend_since(&local_month_start_utc())?;
        let budget = settings.monthly_budget_usd;
        Ok(BudgetStatus {
            month_spend_usd: spend,
            budget_usd: budget,
            ratio: budget.map(|b| if b > 0.0 { spend / b } else { 1.0 }),
            exceeded: budget.is_some_and(|b| spend >= b),
        })
    }

    /// The error a cloud request gets when the budget is used up and the hard stop is on.
    pub fn budget_block(&self) -> Result<Option<Error>> {
        if !self.settings()?.budget_hard_stop {
            return Ok(None);
        }
        let b = self.budget_status()?;
        Ok(b.exceeded.then(|| Error::Api {
            status: 0,
            code: "BUDGET_EXCEEDED".into(),
            message: format!(
                "The monthly cloud budget of ${:.2} is used up (${:.2} spent this month); cloud requests are paused. Raise the budget or turn off the hard stop in Settings",
                b.budget_usd.unwrap_or(0.0),
                b.month_spend_usd
            ),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::parse_delimited;

    #[test]
    fn dataset_roundtrip_and_value_counts() {
        let s = Store::open_in_memory().unwrap();
        let data = parse_delimited("text,label\na,pos\nb, neg\nc,pos\n", b',').unwrap();
        let d = s.insert_dataset("demo", None, &data).unwrap();
        assert_eq!(s.list_datasets().unwrap().len(), 1);
        let vc = s.value_counts(&d.id, "label", 10).unwrap();
        assert_eq!(vc[0].value, "pos");
        assert_eq!(vc[0].count, 2);
        assert_eq!(vc[1].value, "neg");
        let rows = s.dataset_rows_by_index(&d.id, &[2]).unwrap();
        assert_eq!(rows[0].1["text"], "c");
    }

    #[test]
    fn migrates_single_question_predictions() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        // the v1 predictions table, before question ids
        conn.execute_batch(
            "CREATE TABLE predictions (
                experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
                model TEXT NOT NULL,
                row_idx INTEGER NOT NULL,
                ground_truth TEXT NOT NULL,
                predicted TEXT,
                confidence REAL,
                top_prob REAL,
                probabilities TEXT,
                latency_ms REAL,
                error TEXT,
                PRIMARY KEY (experiment_id, model, row_idx)
            );
            INSERT INTO datasets VALUES ('d', 'demo', NULL, '[\"text\",\"label\"]', 2, '2026-01-01');
            INSERT INTO experiments VALUES ('e', 'd', 'old',
                '{\"name\":\"old\",\"dataset_id\":\"d\",\"task\":{\"kind\":\"choice\",\"instructions\":\"?\",\"input_columns\":[\"text\"],\"label_column\":\"label\",\"labels\":[{\"value\":\"a\"},{\"value\":\"b\"}]},\"models\":[\"laya\"]}',
                'completed', NULL, '[0,1]', '2026-01-01', NULL);
            INSERT INTO predictions VALUES ('e', 'laya', 0, 'a', 'a', 0.5, 0.75, '{\"a\":0.75,\"b\":0.25}', 3.0, NULL);
            INSERT INTO predictions VALUES ('e', 'laya', 1, 'b', NULL, NULL, NULL, NULL, NULL, 'boom');",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let s = Store { conn: Mutex::new(conn) };
        let preds = s.predictions("e").unwrap();
        assert_eq!(preds.len(), 2);
        assert!(preds.iter().all(|p| p.question_id == LEGACY_TASK_ID));
        assert_eq!(preds[0].probabilities.as_ref().unwrap()["a"], 0.75);
        assert_eq!(preds[1].error.as_deref(), Some("boom"));
        assert_eq!(s.predictions_for("e", "label").unwrap().len(), 2);
        assert!(s.predictions_for("e", "other").unwrap().is_empty());

        let e = s.get_experiment("e").unwrap();
        assert_eq!(e.config.tasks[0].id, LEGACY_TASK_ID);
        assert_eq!(e.config.input_columns, vec!["text"]);
        assert_eq!(e.progress["laya"], 2);

        // a second question on the same rows does not count as more rows done
        let mut p = preds[0].clone();
        p.question_id = "other".into();
        s.insert_prediction("e", &p).unwrap();
        assert_eq!(s.get_experiment("e").unwrap().progress["laya"], 2);
        assert_eq!(s.predictions("e").unwrap().len(), 3);
    }

    #[test]
    fn migrates_v2_to_v3() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(PREDICTIONS_TABLE).unwrap();
        conn.execute_batch(
            "PRAGMA user_version = 2;
             INSERT INTO datasets VALUES ('d', 'demo', NULL, '[\"text\"]', 1, '2026-01-01');",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let s = Store { conn: Mutex::new(conn) };
        assert_eq!(s.list_datasets().unwrap().len(), 1, "existing data is kept");
        assert!(s.list_providers().unwrap().is_empty());
        s.seed_builtin_providers().unwrap();
        let ids: Vec<String> = s.list_providers().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["typesafe", "openai", "cloudflare"]);
        assert_eq!(s.list_cloud_models(Some("cloudflare")).unwrap().len(), 2);
        assert!(s.usage_summary(None).unwrap().is_empty());
    }

    #[test]
    fn seeding_keeps_user_edits() {
        let s = Store::open_in_memory().unwrap();
        let mut jev = s.get_cloud_model("typesafe", "jev-latest").unwrap().unwrap();
        assert_eq!(jev.input_price_per_mtok, 0.042);
        assert!(jev.builtin && jev.enabled);
        jev.input_price_per_mtok = 0.05;
        jev.enabled = false;
        s.upsert_cloud_model(&jev).unwrap();
        s.delete_cloud_model("cloudflare", "clef").unwrap();
        s.seed_builtin_providers().unwrap();
        s.seed_builtin_providers().unwrap();
        let again = s.get_cloud_model("typesafe", "jev-latest").unwrap().unwrap();
        assert_eq!(again.input_price_per_mtok, 0.05);
        assert!(!again.enabled);
        assert!(s.get_cloud_model("cloudflare", "clef").unwrap().is_some(), "missing built-ins come back");
        assert_eq!(s.list_providers().unwrap().len(), 3);
        assert_eq!(s.list_cloud_models(None).unwrap().len(), 4);
    }

    #[test]
    fn providers_and_usage() {
        let s = Store::open_in_memory().unwrap();
        let p = Provider {
            id: "router".into(),
            kind: ProviderKind::Custom,
            name: "Router".into(),
            base_url: Some("https://r.dev".into()),
            account_id: None,
            has_key: false,
            key_hint: None,
            builtin: false,
        };
        s.insert_provider(&p).unwrap();
        s.set_provider_key_state("router", true, Some("abcd")).unwrap();
        let got = s.get_provider("router").unwrap();
        assert!(got.has_key);
        assert_eq!(got.key_hint.as_deref(), Some("abcd"));
        assert_eq!(s.list_providers().unwrap().last().unwrap().id, "router");
        s.upsert_cloud_model(&CloudModel {
            provider_id: "router".into(),
            model: "jev-latest".into(),
            display_name: "Jev via router".into(),
            description: None,
            input_price_per_mtok: 1.0,
            output_price_per_mtok: 0.0,
            enabled: true,
            builtin: false,
        })
        .unwrap();
        s.delete_provider("router").unwrap();
        assert!(s.list_cloud_models(Some("router")).unwrap().is_empty(), "models go with their provider");

        let log = |model: &str, exp: Option<&str>, tokens: u64, cost: f64| {
            s.log_usage(&UsageEntry {
                source: if exp.is_some() { "experiment" } else { "quick" }.into(),
                experiment_id: exp.map(Into::into),
                model: model.into(),
                requests: 1,
                usage: Usage { input_tokens: tokens, output_tokens: 1 },
                cost_usd: cost,
            })
            .unwrap()
        };
        log("laya", Some("e1"), 10, 0.0);
        log("laya", Some("e1"), 10, 0.0);
        log("laya", None, 10, 0.0);
        log("@openai/gpt-6-luna", Some("e1"), 100, 0.00001);
        log("@typesafe/jev-latest", None, 100, 0.0000042);
        let all = s.usage_summary(None).unwrap();
        assert_eq!(all.iter().map(|r| r.model.as_str()).collect::<Vec<_>>(), vec!["@openai/gpt-6-luna", "@typesafe/jev-latest", "laya"]);
        assert_eq!(all[2], UsageRow { model: "laya".into(), requests: 3, input_tokens: 30, output_tokens: 3, cost_usd: 0.0 });
        let e1 = s.experiment_usage("e1").unwrap();
        assert_eq!(e1.len(), 2);
        assert_eq!(e1[1].requests, 2);
        assert!(s.usage_summary(Some("2999-01-01")).unwrap().is_empty());
    }

    #[test]
    fn migrates_v3_to_v4() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(PREDICTIONS_TABLE).unwrap();
        conn.execute_batch(CLOUD_TABLES).unwrap();
        conn.execute_batch(
            "PRAGMA user_version = 3;
             INSERT INTO datasets VALUES ('d', 'demo', NULL, '[\"text\",\"label\"]', 1, '2026-01-01');
             INSERT INTO dataset_rows VALUES ('d', 0, '{\"text\":\"hi\",\"label\":\"a\"}');
             INSERT INTO usage_log (at, source, experiment_id, model, requests, input_tokens, output_tokens, cost_usd)
                 VALUES ('2026-01-01T00:00:00.000Z', 'quick', NULL, '@openai/gpt-6-luna', 1, 10, 0, 0.5);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 4);
        let s = Store { conn: Mutex::new(conn) };
        assert_eq!(s.usage_summary(None).unwrap().len(), 1, "existing data is kept");
        assert!(s.label_corrections("d").unwrap().is_empty());
        assert!(s.list_question_sets().unwrap().is_empty());
        assert_eq!(s.settings().unwrap(), AppSettings::default());
        s.set_label_correction("d", 0, "label", "b", None).unwrap();
        assert_eq!(s.label_corrections("d").unwrap()[0].original, "a");
        // last January's spend is not this month's
        assert_eq!(s.budget_status().unwrap().month_spend_usd, 0.0);
    }

    #[test]
    fn label_corrections_crud() {
        let s = Store::open_in_memory().unwrap();
        let d = s.insert_dataset("demo", None, &parse_delimited("text,label\na,pos\nb, neg\n", b',').unwrap()).unwrap();
        let c = s.set_label_correction(&d.id, 1, "label", " pos ", Some("  ")).unwrap();
        assert_eq!((c.original.as_str(), c.value.as_str(), c.note.clone()), (" neg", "pos", None));
        assert!(!c.is_confirmation());
        let c = s.set_label_correction(&d.id, 1, "label", "neg", Some("checked")).unwrap();
        assert!(c.is_confirmation(), "same as the original (trimmed)");
        assert_eq!(s.label_corrections(&d.id).unwrap().len(), 1, "one correction per cell");
        assert!(s.set_label_correction(&d.id, 1, "nope", "x", None).is_err());
        assert!(s.set_label_correction(&d.id, 9, "label", "x", None).is_err());
        s.set_label_correction(&d.id, 0, "label", "neg", None).unwrap();
        let rows = s.corrected_rows(&d.id, None).unwrap();
        assert_eq!((rows[0].1["label"].as_str(), rows[0].1["text"].as_str()), ("neg", "a"));
        assert_eq!(s.dataset_rows(&d.id, 0, 1).unwrap()[0].1["label"], "pos", "the raw data is unchanged");
        s.clear_label_correction(&d.id, 0, "label").unwrap();
        assert_eq!(s.label_corrections(&d.id).unwrap().len(), 1);
        s.delete_dataset(&d.id).unwrap();
        assert!(s.label_corrections(&d.id).unwrap().is_empty(), "corrections go with their dataset");
    }

    #[test]
    fn rows_search_and_sort() {
        let s = Store::open_in_memory().unwrap();
        let csv = "name,score,note\nAlpha,10,x\nbeta,9,\ngamma,,Größe\nDelta,100,50% off\nepsilon,abc,a_b\nzeta,-1,ALPHA\n";
        let d = s.insert_dataset("demo", None, &parse_delimited(csv, b',').unwrap()).unwrap();
        let ids = |r: (Vec<(usize, Row)>, usize)| (r.0.iter().map(|(i, _)| *i).collect::<Vec<_>>(), r.1);
        let page = |search: Option<&str>, col: Option<&str>, desc: bool| ids(s.dataset_rows_page(&d.id, 0, 100, search, col, desc).unwrap());

        assert_eq!(page(None, None, false), (vec![0, 1, 2, 3, 4, 5], 6));
        // case-insensitive, any cell, values only (not column names)
        assert_eq!(page(Some("alpha"), None, false), (vec![0, 5], 2));
        assert_eq!(page(Some(" ALPHA "), None, false), (vec![0, 5], 2));
        assert_eq!(page(Some("score"), None, false), (vec![], 0));
        // LIKE wildcards are literal
        assert_eq!(page(Some("%"), None, false), (vec![3], 1));
        assert_eq!(page(Some("_"), None, false), (vec![4], 1));
        // non-ASCII terms fold case in Rust
        assert_eq!(page(Some("GRÖSSE"), None, false), (vec![], 0));
        assert_eq!(page(Some("GRÖ"), None, false), (vec![2], 1));
        // numbers numerically and before text, empty last in both directions
        assert_eq!(page(None, Some("score"), false), (vec![5, 1, 0, 3, 4, 2], 6));
        assert_eq!(page(None, Some("score"), true), (vec![4, 3, 0, 1, 5, 2], 6));
        assert_eq!(page(None, Some("name"), false), (vec![0, 1, 3, 4, 2, 5], 6));
        assert_eq!(page(Some("a"), Some("score"), true).1, 6);
        assert_eq!(page(Some("ö"), Some("score"), true), (vec![2], 1));
        // paging applies after sorting
        let p = s.dataset_rows_page(&d.id, 1, 2, None, Some("score"), false).unwrap();
        assert_eq!((p.0.iter().map(|(i, _)| *i).collect::<Vec<_>>(), p.1), (vec![1, 0], 6));
        assert_eq!(p.0[0].1["name"], "beta");
        // an unknown column sorts like an empty one: by row
        assert_eq!(page(None, Some("missing"), true).0, vec![0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn question_set_versions() {
        let s = Store::open_in_memory().unwrap();
        let payload = |n: usize| serde_json::json!({"context": "", "questions": (0..n).map(|i| serde_json::json!({"kind": "noul", "text": format!("q{i}")})).collect::<Vec<_>>()});
        let input = |id: Option<&str>, name: &str, desc: Option<&str>, p: Value| QuestionSetInput {
            id: id.map(Into::into),
            name: name.into(),
            description: desc.map(Into::into),
            payload: p,
        };
        let a = s.save_question_set(&input(None, "Support triage!", None, payload(2))).unwrap();
        assert_eq!((a.id.as_str(), a.version, a.question_count, a.description.as_str()), ("support-triage", 1, 2, ""));
        let b = s.save_question_set(&input(None, "Support triage", Some("copy"), payload(1))).unwrap();
        assert_eq!(b.id, "support-triage-2");

        // renaming does not bump the version; a changed payload does
        let a2 = s.save_question_set(&input(Some("support-triage"), "Triage", Some("tickets"), payload(2))).unwrap();
        assert_eq!((a2.version, a2.name.as_str(), a2.description.as_str()), (1, "Triage", "tickets"));
        let a3 = s.save_question_set(&input(Some("support-triage"), "Triage", Some("tickets"), payload(3))).unwrap();
        assert_eq!((a3.version, a3.question_count), (2, 3));
        let list = s.list_question_sets().unwrap();
        assert_eq!(list.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["support-triage", "support-triage-2"], "newest first");

        let latest = s.get_question_set("support-triage", None).unwrap();
        assert_eq!((latest.version, latest.payload["questions"].as_array().unwrap().len()), (2, 3));
        let v1 = s.get_question_set("support-triage", Some(1)).unwrap();
        assert_eq!(v1.payload, payload(2));
        assert_eq!(v1.name, "Triage");
        assert!(s.get_question_set("support-triage", Some(3)).is_err());
        assert!(s.save_question_set(&input(None, "  ", None, payload(1))).is_err());
        assert!(s.save_question_set(&input(None, "x", None, serde_json::json!([1]))).is_err());
        assert_eq!(s.save_question_set(&input(None, "???", None, payload(0))).unwrap().id, "question-set");

        s.delete_question_set("support-triage").unwrap();
        assert!(s.get_question_set("support-triage", None).is_err());
        assert_eq!(s.list_question_sets().unwrap().len(), 2);
    }

}
