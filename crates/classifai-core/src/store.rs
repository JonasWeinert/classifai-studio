//! SQLite persistence. One file (`classifai.db`) holds datasets, their rows, experiments, every
//! prediction, cloud providers with their models and prices, a usage log, label corrections,
//! saved question sets, app settings and the app's UI state, so the app and the CLI see the same
//! data. API keys are not stored here (see [`crate::secrets`]).
//!
//! A dataset can be *derived* from another (results saved as a dataset): its rows link to the
//! parent's rows and store only the cells it adds. Reads go through the `resolved_rows` view,
//! which merges the two, so derived datasets behave like any other.

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
    /// The dataset this one's rows link to; None for imported data.
    pub parent_id: Option<String>,
    pub parent_name: Option<String>,
    /// Columns this dataset stores itself on top of its parent's (empty without a parent).
    pub added_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValueCount {
    pub value: String,
    pub count: usize,
}

/// How a column's values are spread: enough to tell labels from free text.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnProfile {
    pub rows: usize,
    /// Rows where the column is empty.
    pub empty: usize,
    /// Distinct non-empty values.
    pub distinct: usize,
    /// The most frequent non-empty values.
    pub top: Vec<ValueCount>,
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
    /// Overwrite the latest version instead of adding one (autosave while drafting).
    #[serde(default)]
    pub amend: bool,
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
const SCHEMA_VERSION: i64 = 9;

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

/// v5: derived datasets (rows that link to a parent row and store only added cells) and the UI
/// state the app used to keep in browser storage.
const V5_TABLES: &str = r#"
ALTER TABLE datasets ADD COLUMN parent_id TEXT;
ALTER TABLE datasets ADD COLUMN added_columns TEXT;
ALTER TABLE dataset_rows ADD COLUMN parent_idx INTEGER;
CREATE INDEX IF NOT EXISTS datasets_parent ON datasets (parent_id);
CREATE TABLE IF NOT EXISTS ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS resolved_rows AS
SELECT r.dataset_id AS dataset_id, r.idx AS idx,
       CASE WHEN r.parent_idx IS NULL THEN r.data ELSE json_patch(COALESCE(p.data, '{}'), r.data) END AS data
FROM dataset_rows r
JOIN datasets d ON d.id = r.dataset_id
LEFT JOIN dataset_rows p ON p.dataset_id = d.parent_id AND p.idx = r.parent_idx;
"#;

/// v6: Bulk runs (one model, many entries, no ground truth) and their answers. Runs over a dataset
/// store row indices only; their inputs are read from the dataset.
const V6_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS bulk_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    source TEXT NOT NULL,
    dataset_id TEXT,
    dataset_name TEXT,
    columns TEXT NOT NULL,
    titles TEXT NOT NULL,
    setup TEXT NOT NULL,
    status TEXT NOT NULL,
    saved_dataset_id TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS bulk_results (
    run_id TEXT NOT NULL REFERENCES bulk_runs(id) ON DELETE CASCADE,
    pos INTEGER NOT NULL,
    row_idx INTEGER NOT NULL,
    input TEXT,
    answers TEXT,
    error TEXT,
    latency_ms REAL,
    cost_usd REAL,
    PRIMARY KEY (run_id, pos)
);
"#;

/// v7: manual labelling sessions, their answers and per-entry marks (skipped, flagged, notes).
const V7_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS label_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    dataset_name TEXT NOT NULL,
    columns TEXT NOT NULL,
    question_set_id TEXT,
    question_set_version INTEGER,
    questions TEXT NOT NULL,
    titles TEXT NOT NULL,
    row_order TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    saved_dataset_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS label_answers (
    session_id TEXT NOT NULL REFERENCES label_sessions(id) ON DELETE CASCADE,
    row_idx INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    value TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (session_id, row_idx, question_id)
);
CREATE TABLE IF NOT EXISTS label_marks (
    session_id TEXT NOT NULL REFERENCES label_sessions(id) ON DELETE CASCADE,
    row_idx INTEGER NOT NULL,
    skipped INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    PRIMARY KEY (session_id, row_idx)
);
"#;

/// v8: latency lookups per model (median in SQL for time estimates).
const V8_TABLES: &str = "CREATE INDEX IF NOT EXISTS predictions_model_latency ON predictions (model, latency_ms);";

/// v9: passages of an entry that a person marked as the reason for an answer (manual labelling).
const V9_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS label_evidence (
    session_id TEXT NOT NULL REFERENCES label_sessions(id) ON DELETE CASCADE,
    row_idx INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    snippets TEXT NOT NULL,
    PRIMARY KEY (session_id, row_idx, question_id)
);
"#;

/// Bring the schema to [`SCHEMA_VERSION`]. Idempotent.
///
/// v0/v1 → v2: predictions gain `question_id`; existing rows answered the single question of
/// that time, so they get [`LEGACY_TASK_ID`].
/// v2 → v3: [`CLOUD_TABLES`].
/// v3 → v4: [`V4_TABLES`].
/// v4 → v5: [`V5_TABLES`].
/// v5 → v6: [`V6_TABLES`].
/// v6 → v7: [`V7_TABLES`].
/// v7 → v8: [`V8_TABLES`].
/// v8 → v9: [`V9_TABLES`].
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
    if version < 5 {
        tx.execute_batch(V5_TABLES)?;
    }
    if version < 6 {
        tx.execute_batch(V6_TABLES)?;
    }
    if version < 7 {
        tx.execute_batch(V7_TABLES)?;
    }
    if version < 8 {
        tx.execute_batch(V8_TABLES)?;
    }
    if version < 9 {
        tx.execute_batch(V9_TABLES)?;
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

    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Experiments and Bulk runs that were running when the app quit are marked cancelled.
    fn recover_interrupted(&self) -> Result<()> {
        self.conn().execute(
            "UPDATE experiments SET status = 'cancelled', error = 'Interrupted: the app was closed while running'
             WHERE status IN ('running', 'pending')",
            [],
        )?;
        self.conn().execute("UPDATE bulk_runs SET status = 'cancelled' WHERE status IN ('running', 'pending')", [])?;
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
            parent_id: None,
            parent_name: None,
            added_columns: Vec::new(),
        })
    }

    const DATASET_SELECT: &'static str =
        "SELECT d.id, d.name, d.source, d.columns, d.row_count, d.created_at, d.parent_id, p.name, d.added_columns
         FROM datasets d LEFT JOIN datasets p ON p.id = d.parent_id";

    fn map_dataset(r: &rusqlite::Row) -> rusqlite::Result<Dataset> {
        let cols: String = r.get(3)?;
        let added: Option<String> = r.get(8)?;
        Ok(Dataset {
            id: r.get(0)?,
            name: r.get(1)?,
            source: r.get(2)?,
            columns: serde_json::from_str(&cols).unwrap_or_default(),
            row_count: r.get::<_, i64>(4)? as usize,
            created_at: r.get(5)?,
            parent_id: r.get(6)?,
            parent_name: r.get(7)?,
            added_columns: added.and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default(),
        })
    }

    pub fn list_datasets(&self) -> Result<Vec<Dataset>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("{} ORDER BY d.created_at DESC", Self::DATASET_SELECT))?;
        let rows = stmt.query_map([], Self::map_dataset)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn get_dataset(&self, id: &str) -> Result<Dataset> {
        self.conn()
            .query_row(&format!("{} WHERE d.id = ?1", Self::DATASET_SELECT), [id], Self::map_dataset)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("dataset {id}")))
    }

    pub fn rename_dataset(&self, id: &str, name: &str) -> Result<()> {
        self.conn().execute("UPDATE datasets SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    /// Deletes a dataset with its experiments. Datasets derived from it keep their rows: the linked
    /// cells are copied into them first.
    pub fn delete_dataset(&self, id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE dataset_rows SET
                data = (SELECT rr.data FROM resolved_rows rr WHERE rr.dataset_id = dataset_rows.dataset_id AND rr.idx = dataset_rows.idx),
                parent_idx = NULL
             WHERE dataset_id IN (SELECT id FROM datasets WHERE parent_id = ?1)",
            [id],
        )?;
        tx.execute("UPDATE datasets SET parent_id = NULL, added_columns = NULL WHERE parent_id = ?1", [id])?;
        tx.execute("DELETE FROM datasets WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Names of the datasets derived from this one.
    pub fn derived_datasets(&self, id: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT name FROM datasets WHERE parent_id = ?1 ORDER BY created_at")?;
        let out = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }

    /// A dataset whose rows link to rows of `parent_id` and store only the given cells: `rows` are
    /// `(parent row index, added cells)`, in the new dataset's order. Added columns that clash with
    /// the parent's get a numeric suffix. Deriving from a derived dataset links to its root and
    /// carries the parent's added cells over, so links are never more than one level deep. Label
    /// corrections of the linked rows are copied.
    pub fn insert_derived_dataset(
        &self,
        parent_id: &str,
        name: &str,
        source: Option<&str>,
        rows: &[(usize, Row)],
    ) -> Result<Dataset> {
        let parent = self.get_dataset(parent_id)?;
        if rows.is_empty() {
            return Err(Error::invalid("nothing to save: no rows"));
        }
        // Column names as given -> unique names next to the parent's columns.
        let mut columns = parent.columns.clone();
        let mut added = parent.added_columns.clone();
        let mut rename: IndexMap<String, String> = IndexMap::new();
        for (_, cells) in rows {
            for key in cells.keys() {
                if rename.contains_key(key) {
                    continue;
                }
                let unique = unique_name(key, &columns);
                columns.push(unique.clone());
                added.push(unique.clone());
                rename.insert(key.clone(), unique);
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // (root id, root row index, carried-over cells) for each requested parent row.
        let root_id = parent.parent_id.clone().unwrap_or_else(|| parent.id.clone());
        let mut links = Vec::with_capacity(rows.len());
        {
            let mut stmt = tx.prepare("SELECT parent_idx, data FROM dataset_rows WHERE dataset_id = ?1 AND idx = ?2")?;
            for (pidx, _) in rows {
                let (link, data): (Option<i64>, String) = stmt
                    .query_row(params![parent.id, *pidx as i64], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?
                    .ok_or_else(|| Error::NotFound(format!("row {} of dataset {}", pidx + 1, parent.name)))?;
                links.push(match (&parent.parent_id, link) {
                    (Some(_), Some(root_idx)) => (root_idx as usize, serde_json::from_str::<Row>(&data)?),
                    _ => (*pidx, Row::new()),
                });
            }
        }
        tx.execute(
            "INSERT INTO datasets (id, name, source, columns, row_count, created_at, parent_id, added_columns)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                name,
                source,
                serde_json::to_string(&columns)?,
                rows.len(),
                created_at,
                root_id,
                serde_json::to_string(&added)?
            ],
        )?;
        {
            let mut insert =
                tx.prepare("INSERT INTO dataset_rows (dataset_id, idx, data, parent_idx) VALUES (?1, ?2, ?3, ?4)")?;
            let mut copy = tx.prepare(
                "INSERT INTO label_corrections (dataset_id, row_idx, column_name, original, value, note, at)
                 SELECT ?1, ?2, column_name, original, value, note, at FROM label_corrections
                 WHERE dataset_id = ?3 AND row_idx = ?4",
            )?;
            for (i, ((pidx, cells), (root_idx, mut data))) in rows.iter().zip(links).enumerate() {
                for (k, v) in cells {
                    data.insert(rename[k].clone(), v.clone());
                }
                insert.execute(params![id, i as i64, serde_json::to_string(&data)?, root_idx as i64])?;
                copy.execute(params![id, i as i64, parent.id, *pidx as i64])?;
            }
        }
        tx.commit()?;
        Ok(Dataset {
            id,
            name: name.into(),
            source: source.map(Into::into),
            columns,
            row_count: rows.len(),
            created_at,
            parent_name: Some(if parent.parent_id.is_some() { parent.parent_name.unwrap_or_default() } else { parent.name }),
            parent_id: Some(root_id),
            added_columns: added,
        })
    }

    /// Save an experiment's predictions as a dataset derived from its dataset: the evaluated rows,
    /// plus a prediction and a confidence column per question (and per model when there are
    /// several).
    pub fn save_experiment_as_dataset(&self, experiment_id: &str, name: &str) -> Result<Dataset> {
        let e = self.get_experiment(experiment_id)?;
        let preds = self.predictions(experiment_id)?;
        let mut questions: Vec<String> = e.config.tasks.iter().map(|t| t.id.clone()).collect();
        for p in &preds {
            if !questions.contains(&p.question_id) {
                questions.push(p.question_id.clone());
            }
        }
        let models: Vec<String> = e.config.models.clone();
        let column = |q: &str, m: &str| {
            if models.len() > 1 { format!("{q} · {}", short_model(m)) } else { q.to_string() }
        };
        let by_key: HashMap<(usize, &str, &str), &Prediction> =
            preds.iter().map(|p| ((p.row_idx, p.model.as_str(), p.question_id.as_str()), p)).collect();
        let rows: Vec<(usize, Row)> = e
            .row_indices
            .iter()
            .map(|&idx| {
                let mut cells = Row::new();
                for q in &questions {
                    for m in &models {
                        let p = by_key.get(&(idx, m.as_str(), q.as_str()));
                        let col = column(q, m);
                        cells.insert(col.clone(), p.and_then(|p| p.predicted.clone()).unwrap_or_default());
                        cells.insert(
                            format!("{col} confidence"),
                            p.and_then(|p| p.confidence).map(|c| format!("{c:.3}")).unwrap_or_default(),
                        );
                    }
                }
                (idx, cells)
            })
            .collect();
        self.insert_derived_dataset(&e.dataset_id, name, Some(&format!("Evaluation: {}", e.name)), &rows)
    }

    pub fn dataset_rows(&self, id: &str, offset: usize, limit: usize) -> Result<Vec<(usize, Row)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT idx, data FROM resolved_rows WHERE dataset_id = ?1 ORDER BY idx LIMIT ?2 OFFSET ?3",
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
        let mut stmt = conn.prepare("SELECT data FROM resolved_rows WHERE dataset_id = ?1 AND idx = ?2")?;
        indices
            .iter()
            .map(|&i| {
                let d: String = stmt.query_row(params![id, i as i64], |r| r.get(0))?;
                Ok((i, serde_json::from_str(&d)?))
            })
            .collect()
    }

    /// Distinct values of one column (trimmed, most frequent first, capped at `limit`) and how many
    /// distinct values there are in all. SQL reads only that column; counting happens here, which
    /// is several times faster than SQLite's GROUP BY on a JSON expression (≈70 ms vs ≈780 ms for
    /// 100k rows).
    pub fn column_profile(&self, id: &str, column: &str, limit: usize) -> Result<ColumnProfile> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut total = 0usize;
        {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT TRIM(CAST(COALESCE(json_extract(data, '$.' || json_quote(?2)), '') AS TEXT)) FROM resolved_rows WHERE dataset_id = ?1",
            )?;
            let mut rows = stmt.query(params![id, column])?;
            while let Some(r) = rows.next()? {
                let v: String = r.get(0)?;
                total += 1;
                *counts.entry(v).or_default() += 1;
            }
        }
        let empty = counts.remove("").unwrap_or(0);
        let distinct = counts.len();
        let mut all: Vec<(String, usize)> = counts.into_iter().collect();
        // Most frequent first, ties by value: only the top `limit` need ordering.
        let cmp = |a: &(String, usize), b: &(String, usize)| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0));
        if all.len() > limit && limit > 0 {
            all.select_nth_unstable_by(limit - 1, cmp);
            all.truncate(limit);
        } else if limit == 0 {
            all.clear();
        }
        all.sort_by(cmp);
        Ok(ColumnProfile { rows: total, empty, distinct, top: all.into_iter().map(|(value, count)| ValueCount { value, count }).collect() })
    }

    /// Only some columns of every row (corrections applied): what planning an experiment needs,
    /// without reading and parsing whole rows.
    pub fn column_cells(&self, dataset_id: &str, columns: &[String]) -> Result<Vec<(usize, Row)>> {
        if columns.is_empty() {
            return Ok(Vec::new());
        }
        let select: Vec<String> = (0..columns.len())
            .map(|i| format!("CAST(COALESCE(json_extract(data, '$.' || json_quote(?{})), '') AS TEXT)", i + 2))
            .collect();
        let mut rows: Vec<(usize, Row)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&format!(
                "SELECT idx, {} FROM resolved_rows WHERE dataset_id = ?1 ORDER BY idx",
                select.join(", ")
            ))?;
            let mut args: Vec<&dyn rusqlite::ToSql> = vec![&dataset_id];
            args.extend(columns.iter().map(|c| c as &dyn rusqlite::ToSql));
            let out = stmt
                .query_map(args.as_slice(), |r| {
                    let mut row = Row::new();
                    for (i, c) in columns.iter().enumerate() {
                        row.insert(c.clone(), r.get(i + 1)?);
                    }
                    Ok((r.get::<_, i64>(0)? as usize, row))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            out
        };
        apply_corrections(&mut rows, &self.corrections_map(dataset_id)?);
        Ok(rows)
    }

    /// Distinct values of one column, most frequent first (trimmed; the empty value included).
    /// Capped at `limit` values.
    pub fn value_counts(&self, id: &str, column: &str, limit: usize) -> Result<Vec<ValueCount>> {
        let p = self.column_profile(id, column, limit)?;
        let mut out = p.top;
        if p.empty > 0 {
            let at = out.iter().position(|v| v.count < p.empty || (v.count == p.empty && v.value.as_str() > "")).unwrap_or(out.len());
            out.insert(at, ValueCount { value: String::new(), count: p.empty });
            out.truncate(limit);
        }
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

/// `name`, or `name 2`, `name 3`… when it is taken.
fn unique_name(name: &str, taken: &[String]) -> String {
    let name = if name.trim().is_empty() { "column" } else { name };
    if !taken.iter().any(|t| t == name) {
        return name.to_string();
    }
    (2..).map(|n| format!("{name} {n}")).find(|c| !taken.contains(c)).unwrap()
}

/// `laya:latest` -> `laya`, `@openai/gpt-6-luna` -> `gpt-6-luna` (as the app shows models).
fn short_model(m: &str) -> &str {
    let m = m.strip_suffix(":latest").unwrap_or(m);
    match m.strip_prefix('@') {
        Some(rest) => rest.split_once('/').map_or(rest, |(_, model)| model),
        None => m,
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
            (SELECT 1 FROM json_each(resolved_rows.data) WHERE CAST(value AS TEXT) LIKE ?2 ESCAPE '\\'))";
        let Some(col) = sort_column else {
            let conn = self.conn();
            let total: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM resolved_rows WHERE {FILTER}"),
                params![id, pattern],
                |r| r.get(0),
            )?;
            let mut stmt = conn.prepare(&format!(
                "SELECT idx, data FROM resolved_rows WHERE {FILTER} ORDER BY idx LIMIT ?3 OFFSET ?4"
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
                 FROM resolved_rows WHERE {FILTER}"
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
    /// Median latency (ms) and how many answered predictions it is based on, computed in SQL.
    pub fn model_latency_median(&self, model: &str) -> Result<(Option<f64>, usize)> {
        let conn = self.conn();
        const WHERE: &str = "model = ?1 AND latency_ms IS NOT NULL AND error IS NULL";
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM predictions WHERE {WHERE}"), [model], |r| r.get(0))?;
        if n == 0 {
            return Ok((None, 0));
        }
        let at = |k: i64| -> rusqlite::Result<f64> {
            conn.query_row(
                &format!("SELECT latency_ms FROM predictions WHERE {WHERE} ORDER BY latency_ms LIMIT 1 OFFSET ?2"),
                params![model, k],
                |r| r.get(0),
            )
        };
        let median = if n % 2 == 1 { at(n / 2)? } else { (at(n / 2 - 1)? + at(n / 2)?) / 2.0 };
        Ok((Some(median), n as usize))
    }

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
                if old != input.payload && input.amend {
                    tx.execute(
                        "UPDATE question_set_versions SET payload = ?3, created_at = ?4 WHERE set_id = ?1 AND version = ?2",
                        params![id, latest.0, payload, now],
                    )?;
                } else if old != input.payload {
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

    // ---- UI state ------------------------------------------------------------------------

    /// Everything the app keeps between launches (drafts, last page, theme…), by key. Values are
    /// owned by the frontend and stored as given.
    pub fn ui_state(&self) -> Result<IndexMap<String, Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, value FROM ui_state ORDER BY key")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().filter_map(|(k, v)| Some((k, serde_json::from_str(&v).ok()?))).collect())
    }

    /// Store one UI state value; `None` (or JSON null) removes it.
    pub fn set_ui_state(&self, key: &str, value: Option<&Value>) -> Result<()> {
        match value.filter(|v| !v.is_null()) {
            Some(v) => self.conn().execute(
                "INSERT INTO ui_state (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, serde_json::to_string(v)?, now_rfc3339()],
            )?,
            None => self.conn().execute("DELETE FROM ui_state WHERE key = ?1", [key])?,
        };
        Ok(())
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

    fn row(cells: &[(&str, &str)]) -> Row {
        cells.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn derived_datasets_link_rows_and_store_only_added_cells() {
        let s = Store::open_in_memory().unwrap();
        let data = parse_delimited("text,label\na,pos\nb,neg\nc,pos\n", b',').unwrap();
        let base = s.insert_dataset("base", None, &data).unwrap();
        s.set_label_correction(&base.id, 2, "label", "neg", None).unwrap();

        // rows 2 and 0 of the base, with a prediction each; "label" clashes and is renamed
        let d = s
            .insert_derived_dataset(
                &base.id,
                "run 1",
                None,
                &[(2, row(&[("pred", "x"), ("label", "p")])), (0, row(&[("pred", "y"), ("label", "q")]))],
            )
            .unwrap();
        assert_eq!(d.columns, ["text", "label", "pred", "label 2"]);
        assert_eq!(d.added_columns, ["pred", "label 2"]);
        assert_eq!(d.parent_name.as_deref(), Some("base"));
        assert_eq!(s.get_dataset(&d.id).unwrap().parent_id.as_deref(), Some(base.id.as_str()));
        let rows = s.dataset_rows(&d.id, 0, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1["text"], "c");
        assert_eq!(rows[0].1["pred"], "x");
        assert_eq!(rows[1].1["text"], "a");
        assert_eq!(rows[1].1["label 2"], "q");
        // only the added cells are stored
        let raw: String = s
            .conn()
            .query_row("SELECT data FROM dataset_rows WHERE dataset_id = ?1 AND idx = 0", [&d.id], |r| r.get(0))
            .unwrap();
        assert!(!raw.contains("text"), "{raw}");
        // search, sort and value counts see linked cells
        assert_eq!(s.dataset_rows_page(&d.id, 0, 10, Some("c"), None, false).unwrap().1, 1);
        assert_eq!(s.value_counts(&d.id, "text", 10).unwrap().len(), 2);
        // the base's correction of row 2 is now the derived dataset's row 0
        assert_eq!(s.corrected_rows(&d.id, Some(&[0])).unwrap()[0].1["label"], "neg");

        // deriving from a derived dataset links to the root and carries cells over
        let d2 = s.insert_derived_dataset(&d.id, "run 2", None, &[(1, row(&[("score", "3")]))]).unwrap();
        assert_eq!(d2.parent_id.as_deref(), Some(base.id.as_str()));
        let r = &s.dataset_rows(&d2.id, 0, 10).unwrap()[0].1;
        assert_eq!((r["text"].as_str(), r["pred"].as_str(), r["score"].as_str()), ("a", "y", "3"));
        assert_eq!(s.derived_datasets(&base.id).unwrap(), ["run 1", "run 2"]);

        // deleting the base keeps derived rows whole
        s.delete_dataset(&base.id).unwrap();
        let d = s.get_dataset(&d.id).unwrap();
        assert!(d.parent_id.is_none() && d.added_columns.is_empty());
        let rows = s.dataset_rows(&d.id, 0, 10).unwrap();
        assert_eq!((rows[0].1["text"].as_str(), rows[0].1["pred"].as_str()), ("c", "x"));
        assert_eq!(s.dataset_rows(&d2.id, 0, 10).unwrap()[0].1["text"], "a");
    }

    #[test]
    fn column_profiles_and_cells_come_from_sql() {
        let s = Store::open_in_memory().unwrap();
        let csv = "text,label\nlong a,pos\nlong b, neg\nlong c,pos\nlong d,\nlong e,x\n";
        let d = s.insert_dataset("demo", None, &parse_delimited(csv, b',').unwrap()).unwrap();
        let p = s.column_profile(&d.id, "label", 2).unwrap();
        assert_eq!((p.rows, p.empty, p.distinct), (5, 1, 3));
        assert_eq!(p.top.iter().map(|v| (v.value.as_str(), v.count)).collect::<Vec<_>>(), [("pos", 2), ("neg", 1)]);

        s.set_label_correction(&d.id, 4, "label", "neg", None).unwrap();
        let cells = s.column_cells(&d.id, &["label".into()]).unwrap();
        assert_eq!(cells.len(), 5);
        assert_eq!(cells[0].1.len(), 1, "only the asked column");
        assert_eq!(cells[4].1["label"], "neg", "corrections applied");
    }

    #[test]
    fn latency_median_in_sql() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.model_latency_median("m").unwrap(), (None, 0));
        let d = s.insert_dataset("d", None, &parse_delimited("t,l\na,x\n", b',').unwrap()).unwrap();
        let config: ExperimentConfig = serde_json::from_value(serde_json::json!({
            "name": "e", "dataset_id": d.id, "input_columns": ["t"],
            "tasks": [{ "id": "l", "kind": "choice", "instructions": "?", "label_column": "l", "labels": [{ "value": "x" }, { "value": "y" }] }],
            "models": ["m"]
        }))
        .unwrap();
        let e = s.create_experiment(&config, &[0]).unwrap();
        for (i, ms) in [40.0, 10.0, 30.0, 20.0].into_iter().enumerate() {
            let p = Prediction { model: "m".into(), row_idx: i, question_id: format!("q{i}"), ground_truth: "x".into(), predicted: Some("x".into()), confidence: None, top_prob: None, probabilities: None, latency_ms: Some(ms), error: None };
            s.insert_prediction(&e, &p).unwrap();
        }
        assert_eq!(s.model_latency_median("m").unwrap(), (Some(25.0), 4));
    }

    #[test]
    fn ui_state_roundtrip() {
        let s = Store::open_in_memory().unwrap();
        s.set_ui_state("theme", Some(&serde_json::json!("dark"))).unwrap();
        s.set_ui_state("draft", Some(&serde_json::json!({ "qs": [1, 2] }))).unwrap();
        s.set_ui_state("theme", Some(&serde_json::json!("light"))).unwrap();
        let all = s.ui_state().unwrap();
        assert_eq!(all["theme"], "light");
        assert_eq!(all["draft"]["qs"][1], 2);
        s.set_ui_state("draft", None).unwrap();
        assert!(!s.ui_state().unwrap().contains_key("draft"));
    }

    #[test]
    fn short_model_names() {
        assert_eq!(short_model("laya:latest"), "laya");
        assert_eq!(short_model("@openai/gpt-6-luna"), "gpt-6-luna");
        assert_eq!(short_model("decider:0.8b"), "decider:0.8b");
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
        assert_eq!(ids, vec!["typesafe", "openai", "cloudflare", "anthropic", "openai-chat"]);
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
        assert_eq!(s.list_providers().unwrap().len(), 5);
        assert_eq!(s.list_cloud_models(None).unwrap().len(), 5);
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
    fn migrates_v3_to_latest() {
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
        assert_eq!(version, SCHEMA_VERSION);
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
            amend: false,
        };
        let a = s.save_question_set(&input(None, "Support triage!", None, payload(2))).unwrap();
        // autosave while drafting keeps v1
        let amended = s.save_question_set(&QuestionSetInput { amend: true, ..input(Some(&a.id), "Support triage!", None, payload(3)) }).unwrap();
        assert_eq!((amended.version, amended.question_count), (1, 3));
        s.save_question_set(&QuestionSetInput { amend: true, ..input(Some(&a.id), "Support triage!", None, payload(2)) }).unwrap();
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

#[cfg(test)]
mod perf {
    use super::*;
    use crate::dataset::ParsedDataset;
    use std::time::Instant;

    /// `cargo test -p classifai-core --release perf_large -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn perf_large_dataset() {
        let s = Store::open_in_memory().unwrap();
        let n = 100_000;
        let rows: Vec<Row> = (0..n)
            .map(|i| {
                [
                    ("text", format!("Customer message number {i}: {}", "lorem ipsum dolor sit amet ".repeat(20))),
                    ("label", ["billing", "technical", "account", "shipping"][i % 4].to_string()),
                    ("note", format!("free note {}", i % 50_000)),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect()
            })
            .collect();
        let d = s.insert_dataset("big", None, &ParsedDataset { columns: vec!["text".into(), "label".into(), "note".into()], rows }).unwrap();

        let t = Instant::now();
        let p = s.column_profile(&d.id, "note", 300).unwrap();
        println!("column_profile(note): {} distinct in {:?}", p.distinct, t.elapsed());
        let t = Instant::now();
        let p = s.column_profile(&d.id, "label", 300).unwrap();
        println!("column_profile(label): {} distinct in {:?}", p.distinct, t.elapsed());

        let t = Instant::now();
        let full = s.corrected_rows(&d.id, None).unwrap();
        println!("old plan input — all rows parsed: {} rows in {:?}", full.len(), t.elapsed());
        let t = Instant::now();
        let cells = s.column_cells(&d.id, &["label".into()]).unwrap();
        println!("new plan input — label column only: {} rows in {:?}", cells.len(), t.elapsed());
        let t = Instant::now();
        let (_, total) = s.dataset_rows_page(&d.id, 0, 50, Some("number 4242"), None, false).unwrap();
        println!("search: {total} matches in {:?}", t.elapsed());
        let t = Instant::now();
        s.dataset_rows_page(&d.id, 0, 50, None, Some("note"), true).unwrap();
        println!("sort by note: {:?}", t.elapsed());
        let t = Instant::now();
        s.dataset_rows_page(&d.id, 5000, 50, None, None, false).unwrap();
        println!("page 101: {:?}", t.elapsed());
    }
}
