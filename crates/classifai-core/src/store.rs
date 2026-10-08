//! SQLite persistence. One file (`classifai.db`) holds datasets, their rows, experiments and
//! every prediction, so the app and the CLI see the same data.

use std::path::Path;
use std::sync::Mutex;

use indexmap::IndexMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::dataset::{ParsedDataset, Row};
use crate::task::TaskSpec;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentConfig {
    pub name: String,
    pub dataset_id: String,
    pub task: TaskSpec,
    pub models: Vec<String>,
    /// Evaluate a deterministic random sample of this many rows; all rows when absent.
    #[serde(default)]
    pub sample_size: Option<usize>,
    /// Parallel requests per model. Default 4.
    #[serde(default)]
    pub concurrency: Option<usize>,
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
    /// model -> predictions stored so far
    pub progress: IndexMap<String, usize>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prediction {
    pub model: String,
    pub row_idx: usize,
    pub ground_truth: String,
    pub predicted: Option<String>,
    pub confidence: Option<f64>,
    pub top_prob: Option<f64>,
    pub probabilities: Option<IndexMap<String, f64>>,
    pub latency_ms: Option<f64>,
    pub error: Option<String>,
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
CREATE TABLE IF NOT EXISTS predictions (
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
"#;

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        let store = Self { conn: Mutex::new(conn) };
        store.recover_interrupted()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
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
            conn.prepare("SELECT model, COUNT(*) FROM predictions WHERE experiment_id = ?1 GROUP BY model")?;
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
             (experiment_id, model, row_idx, ground_truth, predicted, confidence, top_prob, probabilities, latency_ms, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                experiment_id,
                p.model,
                p.row_idx as i64,
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

    pub fn predictions(&self, experiment_id: &str) -> Result<Vec<Prediction>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT model, row_idx, ground_truth, predicted, confidence, top_prob, probabilities, latency_ms, error
             FROM predictions WHERE experiment_id = ?1 ORDER BY model, row_idx",
        )?;
        let out = stmt
            .query_map([experiment_id], |r| {
                let probs: Option<String> = r.get(6)?;
                Ok(Prediction {
                    model: r.get(0)?,
                    row_idx: r.get::<_, i64>(1)? as usize,
                    ground_truth: r.get(2)?,
                    predicted: r.get(3)?,
                    confidence: r.get(4)?,
                    top_prob: r.get(5)?,
                    probabilities: probs.and_then(|s| serde_json::from_str(&s).ok()),
                    latency_ms: r.get(7)?,
                    error: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(out)
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
}
