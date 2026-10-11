//! Manual labelling: a person answers a question set for the entries of a dataset, one entry at a
//! time. A session keeps a snapshot of the questions, the order the entries are shown in and where
//! the person left off; every answer is stored as it is given.

use std::collections::HashMap;

use indexmap::IndexMap;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hf::sample_indices;
use crate::store::Store;
use crate::{now_rfc3339, Error, Result};

#[derive(Debug, Clone, Deserialize)]
pub struct LabelSessionInput {
    pub name: String,
    pub dataset_id: String,
    /// Columns shown for each entry.
    pub columns: Vec<String>,
    #[serde(default)]
    pub question_set_id: Option<String>,
    #[serde(default)]
    pub question_set_version: Option<u32>,
    /// The question set payload (`{ context, questions }`), owned by the app.
    pub questions: Value,
    /// Question id -> title, in order.
    pub titles: IndexMap<String, String>,
    /// `sequential` or `random`.
    #[serde(default)]
    pub order: Option<String>,
    /// Label only this many entries (all when absent).
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LabelSessionSummary {
    pub id: String,
    pub name: String,
    pub dataset_id: String,
    pub dataset_name: String,
    pub columns: Vec<String>,
    pub question_set_id: Option<String>,
    pub question_set_version: Option<u32>,
    pub questions: Value,
    pub titles: IndexMap<String, String>,
    /// Entries in the order they are shown (dataset row indices).
    pub row_order: Vec<usize>,
    pub position: usize,
    pub saved_dataset_id: Option<String>,
    pub saved_dataset_name: Option<String>,
    pub total: usize,
    /// Entries with every question answered.
    pub done: usize,
    /// Entries with some but not all questions answered.
    pub partial: usize,
    pub skipped: usize,
    pub flagged: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LabelMark {
    pub skipped: bool,
    pub flagged: bool,
    pub note: Option<String>,
}

/// A passage of an entry the person marked as context for an answer: the text and the column it is in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LabelSnippet {
    pub column: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LabelSession {
    #[serde(flatten)]
    pub summary: LabelSessionSummary,
    /// row index -> question id -> answer value.
    pub answers: HashMap<usize, IndexMap<String, Value>>,
    pub marks: HashMap<usize, LabelMark>,
    /// row index -> question id -> passages marked as context for that answer.
    pub evidence: HashMap<usize, IndexMap<String, Vec<LabelSnippet>>>,
}

const SUMMARY_SELECT: &str = "SELECT s.id, s.name, s.dataset_id, COALESCE(d.name, s.dataset_name), s.columns, s.question_set_id,
        s.question_set_version, s.questions, s.titles, s.row_order, s.position, s.saved_dataset_id, sd.name,
        s.created_at, s.updated_at
     FROM label_sessions s
     LEFT JOIN datasets d ON d.id = s.dataset_id
     LEFT JOIN datasets sd ON sd.id = s.saved_dataset_id";

fn json<T: serde::de::DeserializeOwned + Default>(s: String) -> T {
    serde_json::from_str(&s).unwrap_or_default()
}

fn answered(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        _ => true,
    }
}

/// What an answer counts as for routing: yes/no, the picked option(s), a rank's first pick.
fn route_keys(kind: &str, v: &Value) -> Vec<String> {
    match v {
        Value::Bool(b) => vec![if *b { "yes" } else { "no" }.to_string()],
        Value::String(s) if !s.is_empty() => vec![s.clone()],
        Value::Number(n) => vec![n.to_string()],
        Value::Array(a) => {
            let all = a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string()));
            if kind == "rank" { all.take(1).collect() } else { all.collect() }
        }
        _ => vec![],
    }
}

/// Follow-up conditions of a session's questions ("ask only when `parent` is one of `answers`"),
/// by question id. Question ids are the `titles` keys, in the same order as the payload's questions.
struct Routes {
    /// id -> (parent id, parent kind, triggering answers)
    by_id: HashMap<String, (String, String, Vec<String>)>,
}

impl Routes {
    fn new(payload: &Value, titles: &IndexMap<String, String>) -> Self {
        let qs = payload.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
        let ids: Vec<&String> = titles.keys().collect();
        let mut by_id = HashMap::new();
        if qs.len() == ids.len() {
            let rid_of = |q: &Value| q.get("rid").and_then(Value::as_str).map(str::to_string);
            for (i, q) in qs.iter().enumerate() {
                let Some(when) = q.get("when").filter(|w| !w.is_null()) else { continue };
                let parent_rid = when.get("parent").and_then(Value::as_str).unwrap_or_default();
                let answers: Vec<String> =
                    when.get("answers").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let Some(p) = qs.iter().position(|x| rid_of(x).as_deref() == Some(parent_rid)).filter(|&p| p != i) else { continue };
                let kind = qs[p].get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
                if answers.is_empty() || !["choice", "noul", "score", "multi", "rank"].contains(&kind.as_str()) {
                    continue;
                }
                by_id.insert(ids[i].clone(), (ids[p].clone(), kind, answers));
            }
        }
        Self { by_id }
    }

    fn applies(&self, id: &str, answers: &HashMap<String, Value>, depth: usize) -> bool {
        let Some((parent, kind, wanted)) = self.by_id.get(id) else { return true };
        if depth > 20 || !self.applies(parent, answers, depth + 1) {
            return depth > 20;
        }
        let keys = answers.get(parent).map(|v| route_keys(kind, v)).unwrap_or_default();
        keys.iter().any(|k| wanted.iter().any(|w| w.trim().eq_ignore_ascii_case(k.trim())))
    }
}

impl Store {
    pub fn create_label_session(&self, input: &LabelSessionInput) -> Result<LabelSessionSummary> {
        let d = self.get_dataset(&input.dataset_id)?;
        if input.titles.is_empty() {
            return Err(Error::invalid("add at least one question"));
        }
        if input.columns.is_empty() {
            return Err(Error::invalid("pick at least one column to show"));
        }
        let n = input.limit.unwrap_or(d.row_count).min(d.row_count);
        let order: Vec<usize> = match input.order.as_deref() {
            Some("random") => {
                let mut picks = sample_indices(d.row_count, n, input.seed.unwrap_or(1));
                // Shuffle the sample too, so a random session doesn't run in row order.
                let mut state = input.seed.unwrap_or(1).wrapping_mul(0x2545_F491_4F6C_DD1D) | 1;
                for i in (1..picks.len()).rev() {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    picks.swap(i, (state % (i as u64 + 1)) as usize);
                }
                picks
            }
            _ => (0..n).collect(),
        };
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_rfc3339();
        self.conn().execute(
            "INSERT INTO label_sessions (id, name, dataset_id, dataset_name, columns, question_set_id, question_set_version,
                questions, titles, row_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                id,
                input.name.trim(),
                d.id,
                d.name,
                serde_json::to_string(&input.columns)?,
                input.question_set_id,
                input.question_set_version,
                serde_json::to_string(&input.questions)?,
                serde_json::to_string(&input.titles)?,
                serde_json::to_string(&order)?,
                now
            ],
        )?;
        self.label_session_summary(&id)
    }

    fn map_session(&self, r: &rusqlite::Row) -> rusqlite::Result<LabelSessionSummary> {
        Ok(LabelSessionSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            dataset_id: r.get(2)?,
            dataset_name: r.get(3)?,
            columns: json(r.get(4)?),
            question_set_id: r.get(5)?,
            question_set_version: r.get(6)?,
            questions: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(Value::Null),
            titles: json(r.get(8)?),
            row_order: json(r.get(9)?),
            position: r.get::<_, i64>(10)? as usize,
            saved_dataset_id: r.get(11)?,
            saved_dataset_name: r.get(12)?,
            total: 0,
            done: 0,
            partial: 0,
            skipped: 0,
            flagged: 0,
            created_at: r.get(13)?,
            updated_at: r.get(14)?,
        })
    }

    /// Fill in the counts of a session from its answers and marks. An entry is done when every
    /// question that applies to it is answered (follow-ups apply only once triggered).
    fn count_session(&self, s: &mut LabelSessionSummary) -> Result<()> {
        let conn = self.conn();
        let routes = Routes::new(&s.questions, &s.titles);
        let mut per_row: HashMap<usize, HashMap<String, Value>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT row_idx, question_id, value FROM label_answers WHERE session_id = ?1")?;
        for r in stmt.query_map([&s.id], |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
            let (row, q, v) = r?;
            if s.titles.contains_key(&q) {
                per_row.entry(row).or_default().insert(q, serde_json::from_str(&v).unwrap_or(Value::Null));
            }
        }
        let (skipped, flagged): (i64, i64) = conn.query_row(
            "SELECT COALESCE(SUM(skipped), 0), COALESCE(SUM(flagged), 0) FROM label_marks WHERE session_id = ?1",
            [&s.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let (mut done, mut partial) = (0, 0);
        for answers in per_row.values() {
            let applies: Vec<&String> = s.titles.keys().filter(|id| routes.applies(id, answers, 0)).collect();
            let n = applies.iter().filter(|id| answers.get(**id).is_some_and(answered)).count();
            if n > 0 && n >= applies.len() {
                done += 1;
            } else if n > 0 {
                partial += 1;
            }
        }
        s.total = s.row_order.len();
        s.done = done;
        s.partial = partial;
        s.skipped = skipped as usize;
        s.flagged = flagged as usize;
        Ok(())
    }

    pub fn label_session_summary(&self, id: &str) -> Result<LabelSessionSummary> {
        let mut s = {
            let conn = self.conn();
            conn.query_row(&format!("{SUMMARY_SELECT} WHERE s.id = ?1"), [id], |r| self.map_session(r))
                .optional()?
                .ok_or_else(|| Error::NotFound(format!("labelling session {id}")))?
        };
        self.count_session(&mut s)?;
        Ok(s)
    }

    /// Most recently worked on first.
    pub fn list_label_sessions(&self) -> Result<Vec<LabelSessionSummary>> {
        let mut out: Vec<LabelSessionSummary> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&format!("{SUMMARY_SELECT} ORDER BY s.updated_at DESC"))?;
            let rows = stmt.query_map([], |r| self.map_session(r))?.collect::<rusqlite::Result<_>>()?;
            rows
        };
        for s in &mut out {
            self.count_session(s)?;
        }
        Ok(out)
    }

    pub fn get_label_session(&self, id: &str) -> Result<LabelSession> {
        let summary = self.label_session_summary(id)?;
        let conn = self.conn();
        let mut answers: HashMap<usize, IndexMap<String, Value>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT row_idx, question_id, value FROM label_answers WHERE session_id = ?1")?;
        for r in stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
            let (row, q, v) = r?;
            answers.entry(row).or_default().insert(q, serde_json::from_str(&v).unwrap_or(Value::Null));
        }
        let mut marks = HashMap::new();
        let mut stmt = conn.prepare("SELECT row_idx, skipped, flagged, note FROM label_marks WHERE session_id = ?1")?;
        for r in stmt.query_map([id], |r| {
            Ok((r.get::<_, i64>(0)? as usize, LabelMark { skipped: r.get(1)?, flagged: r.get(2)?, note: r.get(3)? }))
        })? {
            let (row, m) = r?;
            marks.insert(row, m);
        }
        let mut evidence: HashMap<usize, IndexMap<String, Vec<LabelSnippet>>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT row_idx, question_id, snippets FROM label_evidence WHERE session_id = ?1")?;
        for r in stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
            let (row, q, v) = r?;
            evidence.entry(row).or_default().insert(q, json(v));
        }
        Ok(LabelSession { summary, answers, marks, evidence })
    }

    fn touch_label_session(&self, id: &str) -> Result<()> {
        self.conn().execute("UPDATE label_sessions SET updated_at = ?2 WHERE id = ?1", params![id, now_rfc3339()])?;
        Ok(())
    }

    /// Store (or, with None / null, clear) one answer.
    pub fn set_label_answer(&self, id: &str, row_idx: usize, question_id: &str, value: Option<&Value>) -> Result<()> {
        match value.filter(|v| !v.is_null()) {
            Some(v) => self.conn().execute(
                "INSERT INTO label_answers (session_id, row_idx, question_id, value, at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (session_id, row_idx, question_id) DO UPDATE SET value = excluded.value, at = excluded.at",
                params![id, row_idx as i64, question_id, serde_json::to_string(v)?, now_rfc3339()],
            )?,
            None => self.conn().execute(
                "DELETE FROM label_answers WHERE session_id = ?1 AND row_idx = ?2 AND question_id = ?3",
                params![id, row_idx as i64, question_id],
            )?,
        };
        self.touch_label_session(id)
    }

    pub fn set_label_mark(&self, id: &str, row_idx: usize, mark: &LabelMark) -> Result<()> {
        let note = mark.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
        if !mark.skipped && !mark.flagged && note.is_none() {
            self.conn().execute("DELETE FROM label_marks WHERE session_id = ?1 AND row_idx = ?2", params![id, row_idx as i64])?;
        } else {
            self.conn().execute(
                "INSERT INTO label_marks (session_id, row_idx, skipped, flagged, note) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (session_id, row_idx) DO UPDATE SET skipped = excluded.skipped, flagged = excluded.flagged, note = excluded.note",
                params![id, row_idx as i64, mark.skipped, mark.flagged, note],
            )?;
        }
        self.touch_label_session(id)
    }

    /// Replace the context passages of one answer (an empty list clears them).
    pub fn set_label_evidence(&self, id: &str, row_idx: usize, question_id: &str, snippets: &[LabelSnippet]) -> Result<()> {
        if snippets.is_empty() {
            self.conn().execute(
                "DELETE FROM label_evidence WHERE session_id = ?1 AND row_idx = ?2 AND question_id = ?3",
                params![id, row_idx as i64, question_id],
            )?;
        } else {
            self.conn().execute(
                "INSERT INTO label_evidence (session_id, row_idx, question_id, snippets) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (session_id, row_idx, question_id) DO UPDATE SET snippets = excluded.snippets",
                params![id, row_idx as i64, question_id, serde_json::to_string(snippets)?],
            )?;
        }
        self.touch_label_session(id)
    }

    /// Where the person is (index into the session's order), so they continue there next time.
    pub fn set_label_position(&self, id: &str, position: usize) -> Result<()> {
        self.conn().execute("UPDATE label_sessions SET position = ?2 WHERE id = ?1", params![id, position as i64])?;
        Ok(())
    }

    /// Change what a session shows or asks. Answers to removed questions are kept but not counted.
    pub fn update_label_session(&self, id: &str, name: Option<&str>, columns: Option<&[String]>, questions: Option<(&Value, &IndexMap<String, String>)>) -> Result<()> {
        let conn = self.conn();
        if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
            conn.execute("UPDATE label_sessions SET name = ?2 WHERE id = ?1", params![id, n])?;
        }
        if let Some(c) = columns {
            conn.execute("UPDATE label_sessions SET columns = ?2 WHERE id = ?1", params![id, serde_json::to_string(c)?])?;
        }
        if let Some((q, titles)) = questions {
            conn.execute(
                "UPDATE label_sessions SET questions = ?2, titles = ?3 WHERE id = ?1",
                params![id, serde_json::to_string(q)?, serde_json::to_string(titles)?],
            )?;
        }
        Ok(())
    }

    pub fn set_label_session_saved(&self, id: &str, dataset_id: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE label_sessions SET saved_dataset_id = ?2 WHERE id = ?1", params![id, dataset_id])?;
        Ok(())
    }

    pub fn delete_label_session(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM label_sessions WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::parse_delimited;
    use serde_json::json;

    #[test]
    fn sessions_track_answers_marks_and_progress() {
        let s = Store::open_in_memory().unwrap();
        let d = s.insert_dataset("t", None, &parse_delimited("text\na\nb\nc\nd\n", b',').unwrap()).unwrap();
        let titles: IndexMap<String, String> =
            [("team", "Which team?"), ("urgent", "Urgent?")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let input = LabelSessionInput {
            name: "triage".into(),
            dataset_id: d.id.clone(),
            columns: vec!["text".into()],
            question_set_id: None,
            question_set_version: None,
            questions: json!({ "context": "", "questions": [] }),
            titles: titles.clone(),
            order: Some("random".into()),
            limit: Some(3),
            seed: Some(5),
        };
        let sess = s.create_label_session(&input).unwrap();
        assert_eq!(sess.total, 3);
        let mut sorted = sess.row_order.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 3, "distinct rows");

        s.set_label_answer(&sess.id, 0, "team", Some(&json!("billing"))).unwrap();
        s.set_label_answer(&sess.id, 0, "urgent", Some(&json!(true))).unwrap();
        s.set_label_answer(&sess.id, 1, "team", Some(&json!("technical"))).unwrap();
        s.set_label_mark(&sess.id, 2, &LabelMark { skipped: true, flagged: false, note: Some(" unclear ".into()) }).unwrap();
        s.set_label_position(&sess.id, 2).unwrap();
        let got = s.get_label_session(&sess.id).unwrap();
        assert_eq!((got.summary.done, got.summary.partial, got.summary.skipped, got.summary.position), (1, 1, 1, 2));
        assert_eq!(got.answers[&0]["urgent"], true);
        assert_eq!(got.marks[&2].note.as_deref(), Some("unclear"));

        // context passages
        let snip = |t: &str| LabelSnippet { column: "text".into(), text: t.into() };
        s.set_label_evidence(&sess.id, 0, "team", &[snip("a"), snip("b")]).unwrap();
        assert_eq!(s.get_label_session(&sess.id).unwrap().evidence[&0]["team"], vec![snip("a"), snip("b")]);
        s.set_label_evidence(&sess.id, 0, "team", &[]).unwrap();
        assert!(s.get_label_session(&sess.id).unwrap().evidence.is_empty());

        // clearing
        s.set_label_answer(&sess.id, 0, "urgent", None).unwrap();
        s.set_label_mark(&sess.id, 2, &LabelMark::default()).unwrap();
        let got = s.label_session_summary(&sess.id).unwrap();
        assert_eq!((got.done, got.partial, got.skipped), (0, 2, 0));

        // removing a question changes what counts as done
        let fewer: IndexMap<String, String> = titles.into_iter().take(1).collect();
        s.update_label_session(&sess.id, Some("triage v2"), None, Some((&json!({}), &fewer))).unwrap();
        let got = s.label_session_summary(&sess.id).unwrap();
        assert_eq!((got.name.as_str(), got.done), ("triage v2", 2));

        let seq = s.create_label_session(&LabelSessionInput { order: None, limit: None, ..input }).unwrap();
        assert_eq!(seq.row_order, vec![0, 1, 2, 3]);
        assert_eq!(s.list_label_sessions().unwrap().len(), 2);
        s.delete_label_session(&seq.id).unwrap();
        assert_eq!(s.list_label_sessions().unwrap().len(), 1);
    }

    #[test]
    fn follow_ups_count_only_when_triggered() {
        let s = Store::open_in_memory().unwrap();
        let d = s.insert_dataset("t", None, &parse_delimited("text\na\nb\nc\n", b',').unwrap()).unwrap();
        let titles: IndexMap<String, String> =
            [("refund", "Refund?"), ("why", "Why not?")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let questions = json!({ "context": "", "questions": [
            { "kind": "noul", "text": "Refund?", "rid": "p1" },
            { "kind": "choice", "text": "Why not?", "rid": "c1", "when": { "parent": "p1", "answers": ["no"] } },
        ]});
        let sess = s
            .create_label_session(&LabelSessionInput {
                name: "r".into(),
                dataset_id: d.id.clone(),
                columns: vec!["text".into()],
                question_set_id: None,
                question_set_version: None,
                questions,
                titles,
                order: None,
                limit: None,
                seed: None,
            })
            .unwrap();
        s.set_label_answer(&sess.id, 0, "refund", Some(&json!(true))).unwrap(); // yes: follow-up not asked -> done
        s.set_label_answer(&sess.id, 1, "refund", Some(&json!(false))).unwrap(); // no: follow-up open -> partial
        s.set_label_answer(&sess.id, 2, "refund", Some(&json!(false))).unwrap();
        s.set_label_answer(&sess.id, 2, "why", Some(&json!("price"))).unwrap(); // -> done
        let got = s.label_session_summary(&sess.id).unwrap();
        assert_eq!((got.done, got.partial), (2, 1));
    }
}
