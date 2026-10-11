//! Bulk runs: one model answers the same questions for many entries, without ground truth. The app
//! drives the requests and stores answers as they arrive; runs over a dataset keep only row
//! indices, and their inputs are read back from the dataset (like derived datasets).

use indexmap::IndexMap;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::Store;
use crate::{now_rfc3339, Error, Result};

#[derive(Debug, Clone, Deserialize)]
pub struct BulkRunInput {
    pub name: String,
    pub model: String,
    /// `paste` or `dataset`
    pub source: String,
    #[serde(default)]
    pub dataset_id: Option<String>,
    /// Input columns of a dataset run.
    #[serde(default)]
    pub columns: Vec<String>,
    /// Question id -> title.
    pub titles: IndexMap<String, String>,
    /// Owned by the app (questions, context, limits) so a run can be duplicated.
    pub setup: Value,
    pub entries: Vec<BulkEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BulkEntry {
    /// Dataset row index, or line number of a pasted entry.
    pub row_idx: usize,
    /// The text of a pasted entry; ignored for dataset runs.
    #[serde(default)]
    pub input: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BulkResult {
    /// Position of the entry in the run.
    pub pos: usize,
    #[serde(default)]
    pub answers: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
    #[serde(default)]
    pub latency_ms: Option<f64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BulkRunSummary {
    pub id: String,
    pub name: String,
    pub model: String,
    pub source: String,
    pub dataset_id: Option<String>,
    pub dataset_name: Option<String>,
    pub columns: Vec<String>,
    pub titles: IndexMap<String, String>,
    pub setup: Value,
    /// `running`, `completed` or `cancelled`
    pub status: String,
    pub saved_dataset_id: Option<String>,
    pub saved_dataset_name: Option<String>,
    pub total: usize,
    pub answered: usize,
    pub failed: usize,
    pub cost_usd: f64,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BulkRow {
    pub pos: usize,
    pub idx: usize,
    pub input: String,
    /// The input columns of a dataset run.
    pub fields: Option<IndexMap<String, String>>,
    pub answers: Option<Value>,
    pub error: Option<Value>,
    pub latency: Option<f64>,
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkRun {
    #[serde(flatten)]
    pub summary: BulkRunSummary,
    pub rows: Vec<BulkRow>,
}

const SUMMARY_SELECT: &str = "SELECT r.id, r.name, r.model, r.source, r.dataset_id, COALESCE(d.name, r.dataset_name), r.columns, r.titles,
        r.setup, r.status, s.id, s.name,
        (SELECT COUNT(*) FROM bulk_results b WHERE b.run_id = r.id),
        (SELECT COUNT(*) FROM bulk_results b WHERE b.run_id = r.id AND b.answers IS NOT NULL),
        (SELECT COUNT(*) FROM bulk_results b WHERE b.run_id = r.id AND b.error IS NOT NULL),
        (SELECT COALESCE(SUM(cost_usd), 0) FROM bulk_results b WHERE b.run_id = r.id),
        r.created_at, r.finished_at
     FROM bulk_runs r
     LEFT JOIN datasets d ON d.id = r.dataset_id
     LEFT JOIN datasets s ON s.id = r.saved_dataset_id";

fn json<T: serde::de::DeserializeOwned + Default>(s: String) -> T {
    serde_json::from_str(&s).unwrap_or_default()
}

fn map_summary(r: &rusqlite::Row) -> rusqlite::Result<BulkRunSummary> {
    Ok(BulkRunSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        model: r.get(2)?,
        source: r.get(3)?,
        dataset_id: r.get(4)?,
        dataset_name: r.get(5)?,
        columns: json(r.get(6)?),
        titles: json(r.get(7)?),
        setup: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or(Value::Null),
        status: r.get(9)?,
        saved_dataset_id: r.get(10)?,
        saved_dataset_name: r.get(11)?,
        total: r.get::<_, i64>(12)? as usize,
        answered: r.get::<_, i64>(13)? as usize,
        failed: r.get::<_, i64>(14)? as usize,
        cost_usd: r.get(15)?,
        created_at: r.get(16)?,
        finished_at: r.get(17)?,
    })
}

impl Store {
    /// Create a run with all its entries (none answered yet), status `running`.
    pub fn create_bulk_run(&self, input: &BulkRunInput) -> Result<BulkRunSummary> {
        let dataset = match (input.source.as_str(), &input.dataset_id) {
            ("dataset", Some(id)) => Some(self.get_dataset(id)?),
            ("dataset", None) => return Err(Error::invalid("a dataset run needs a dataset")),
            ("paste", _) => None,
            (other, _) => return Err(Error::invalid(format!("unknown source \"{other}\""))),
        };
        if input.entries.is_empty() {
            return Err(Error::invalid("nothing to run: no entries"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO bulk_runs (id, name, model, source, dataset_id, dataset_name, columns, titles, setup, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', ?10)",
            params![
                id,
                input.name.trim(),
                input.model,
                input.source,
                dataset.as_ref().map(|d| d.id.clone()),
                dataset.as_ref().map(|d| d.name.clone()),
                serde_json::to_string(&input.columns)?,
                serde_json::to_string(&input.titles)?,
                serde_json::to_string(&input.setup)?,
                now_rfc3339()
            ],
        )?;
        {
            let mut stmt = tx.prepare("INSERT INTO bulk_results (run_id, pos, row_idx, input) VALUES (?1, ?2, ?3, ?4)")?;
            for (pos, e) in input.entries.iter().enumerate() {
                let text = if dataset.is_some() { None } else { e.input.as_deref() };
                stmt.execute(params![id, pos as i64, e.row_idx as i64, text])?;
            }
        }
        tx.commit()?;
        drop(conn);
        self.bulk_run_summary(&id)
    }

    pub fn put_bulk_results(&self, run_id: &str, results: &[BulkResult]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE bulk_results SET answers = ?3, error = ?4, latency_ms = ?5, cost_usd = ?6 WHERE run_id = ?1 AND pos = ?2",
            )?;
            for r in results {
                let enc = |v: &Option<Value>| v.as_ref().filter(|v| !v.is_null()).map(serde_json::to_string).transpose();
                stmt.execute(params![run_id, r.pos as i64, enc(&r.answers)?, enc(&r.error)?, r.latency_ms, r.cost_usd])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// `completed` or `cancelled`.
    pub fn finish_bulk_run(&self, id: &str, status: &str) -> Result<()> {
        if !matches!(status, "completed" | "cancelled") {
            return Err(Error::invalid(format!("unknown status \"{status}\"")));
        }
        self.conn().execute(
            "UPDATE bulk_runs SET status = ?2, finished_at = ?3 WHERE id = ?1",
            params![id, status, now_rfc3339()],
        )?;
        Ok(())
    }

    pub fn list_bulk_runs(&self) -> Result<Vec<BulkRunSummary>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("{SUMMARY_SELECT} ORDER BY r.created_at DESC"))?;
        let out = stmt.query_map([], map_summary)?.collect::<rusqlite::Result<_>>()?;
        Ok(out)
    }

    pub fn bulk_run_summary(&self, id: &str) -> Result<BulkRunSummary> {
        self.conn()
            .query_row(&format!("{SUMMARY_SELECT} WHERE r.id = ?1"), [id], map_summary)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("bulk run {id}")))
    }

    /// A run with every entry. Inputs of dataset runs come from the dataset (several columns as
    /// "column: value" lines); they are empty if the dataset was deleted.
    pub fn get_bulk_run(&self, id: &str) -> Result<BulkRun> {
        let summary = self.bulk_run_summary(id)?;
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT b.pos, b.row_idx, b.input, rr.data, b.answers, b.error, b.latency_ms, b.cost_usd
             FROM bulk_results b
             JOIN bulk_runs r ON r.id = b.run_id
             LEFT JOIN resolved_rows rr ON rr.dataset_id = r.dataset_id AND rr.idx = b.row_idx
             WHERE b.run_id = ?1 ORDER BY b.pos",
        )?;
        let cols = &summary.columns;
        let rows = stmt
            .query_map([id], |r| {
                let data: Option<String> = r.get(3)?;
                let parse = |s: Option<String>| s.and_then(|s| serde_json::from_str::<Value>(&s).ok());
                let (input, fields) = if summary.source == "dataset" {
                    let row: IndexMap<String, String> = data.and_then(|d| serde_json::from_str(&d).ok()).unwrap_or_default();
                    let fields: IndexMap<String, String> =
                        cols.iter().map(|c| (c.clone(), row.get(c).cloned().unwrap_or_default())).collect();
                    let input = if cols.len() == 1 {
                        fields.values().next().cloned().unwrap_or_default()
                    } else {
                        fields.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n")
                    };
                    (input, Some(fields))
                } else {
                    (r.get::<_, Option<String>>(2)?.unwrap_or_default(), None)
                };
                Ok(BulkRow {
                    pos: r.get::<_, i64>(0)? as usize,
                    idx: r.get::<_, i64>(1)? as usize,
                    input,
                    fields,
                    answers: parse(r.get(4)?),
                    error: parse(r.get(5)?),
                    latency: r.get(6)?,
                    cost: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(BulkRun { summary, rows })
    }

    pub fn rename_bulk_run(&self, id: &str, name: &str) -> Result<()> {
        self.conn().execute("UPDATE bulk_runs SET name = ?2 WHERE id = ?1", params![id, name.trim()])?;
        Ok(())
    }

    /// Remember the dataset a run's answers were saved as.
    pub fn set_bulk_run_saved(&self, id: &str, dataset_id: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE bulk_runs SET saved_dataset_id = ?2 WHERE id = ?1", params![id, dataset_id])?;
        Ok(())
    }

    pub fn delete_bulk_run(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM bulk_runs WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::parse_delimited;
    use serde_json::json;

    #[test]
    fn bulk_runs_store_answers_and_read_inputs_from_the_dataset() {
        let s = Store::open_in_memory().unwrap();
        let d = s.insert_dataset("tickets", None, &parse_delimited("subject,body\nhi,there\nyo,again\n", b',').unwrap()).unwrap();
        let input = |source: &str, dataset_id: Option<String>, columns: Vec<String>| BulkRunInput {
            name: "run".into(),
            model: "laya".into(),
            source: source.into(),
            dataset_id,
            columns,
            titles: [("team".to_string(), "Which team?".to_string())].into_iter().collect(),
            setup: json!({ "limit": 2 }),
            entries: vec![BulkEntry { row_idx: 1, input: Some("ignored".into()) }, BulkEntry { row_idx: 0, input: None }],
        };
        let run = s.create_bulk_run(&input("dataset", Some(d.id.clone()), vec!["subject".into(), "body".into()])).unwrap();
        assert_eq!((run.status.as_str(), run.total, run.answered), ("running", 2, 0));
        s.put_bulk_results(
            &run.id,
            &[
                BulkResult { pos: 0, answers: Some(json!({ "team": { "type": "noul", "noul": 0.9 } })), error: None, latency_ms: Some(12.0), cost_usd: Some(0.5) },
                BulkResult { pos: 1, answers: None, error: Some(json!({ "code": "X", "message": "boom" })), latency_ms: None, cost_usd: None },
            ],
        )
        .unwrap();
        s.finish_bulk_run(&run.id, "completed").unwrap();
        let r = s.get_bulk_run(&run.id).unwrap();
        assert_eq!((r.summary.answered, r.summary.failed, r.summary.cost_usd), (1, 1, 0.5));
        assert_eq!(r.summary.status, "completed");
        assert_eq!(r.rows[0].input, "subject: yo\nbody: again");
        assert_eq!(r.rows[0].fields.as_ref().unwrap()["subject"], "yo");
        assert_eq!(r.rows[0].answers.as_ref().unwrap()["team"]["noul"], 0.9);
        assert_eq!(r.rows[1].error.as_ref().unwrap()["message"], "boom");
        let raw: Option<String> =
            s.conn().query_row("SELECT input FROM bulk_results WHERE run_id = ?1 AND pos = 0", [&run.id], |r| r.get(0)).unwrap();
        assert!(raw.is_none(), "dataset inputs are not copied");

        let saved = s.insert_derived_dataset(&d.id, "saved", None, &[(1, Default::default())]).unwrap();
        s.set_bulk_run_saved(&run.id, Some(&saved.id)).unwrap();
        assert_eq!(s.bulk_run_summary(&run.id).unwrap().saved_dataset_name.as_deref(), Some("saved"));

        let pasted = s.create_bulk_run(&input("paste", None, vec![])).unwrap();
        assert_eq!(s.get_bulk_run(&pasted.id).unwrap().rows[0].input, "ignored");
        assert_eq!(s.list_bulk_runs().unwrap().len(), 2);
        s.delete_bulk_run(&pasted.id).unwrap();
        assert_eq!(s.list_bulk_runs().unwrap().len(), 1);
        // the dataset name survives the dataset
        s.delete_dataset(&d.id).unwrap();
        let r = s.get_bulk_run(&run.id).unwrap();
        assert_eq!(r.summary.dataset_name.as_deref(), Some("tickets"));
        assert_eq!(r.rows[0].input, "subject: \nbody: ");
    }
}
