//! SQLite persistence. One file (`classifai.db`) holds datasets, their rows, experiments, every
//! prediction, cloud providers with their models and prices, and a usage log, so the app and the
//! CLI see the same data. API keys are not stored here (see [`crate::secrets`]).

use std::path::Path;
use std::sync::Mutex;

use indexmap::IndexMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

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
const SCHEMA_VERSION: i64 = 3;

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

/// Bring the schema to [`SCHEMA_VERSION`]. Idempotent.
///
/// v0/v1 → v2: predictions gain `question_id`; existing rows answered the single question of
/// that time, so they get [`LEGACY_TASK_ID`].
/// v2 → v3: [`CLOUD_TABLES`].
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
        assert_eq!(version, 3);
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
}
