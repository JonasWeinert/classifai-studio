//! Classification tasks: an experiment shares its input columns and context across several
//! questions, each with its own ground-truth column and labels mapped onto an Ollaya question.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dataset::Row;
use crate::ollaya::{Answer, NoulCriteria, Question};
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    /// Multi-class: an Ollaya `choice` question with one option per label (2–255).
    Choice,
    /// Two labels, asked as an Ollaya `noul` (yes/no probability) with a threshold.
    Binary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelSpec {
    /// The ground-truth value exactly as it appears in the dataset (after trimming).
    pub value: String,
    /// Optional natural-language description shown to the model.
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSpec {
    /// Question id, unique within an experiment; the key of the question sent to Ollaya.
    #[serde(default = "default_task_id")]
    pub id: String,
    pub kind: TaskKind,
    /// The question text, e.g. "What is the sentiment of this review?"
    pub instructions: String,
    /// Extra context for this question only, appended to the instructions.
    #[serde(default)]
    pub context: Option<String>,
    pub label_column: String,
    pub labels: Vec<LabelSpec>,
    /// Binary only: the label that counts as `true`.
    #[serde(default)]
    pub positive_label: Option<String>,
    /// Binary only: P(true) at or above this is predicted positive. Default 0.5.
    #[serde(default)]
    pub threshold: Option<f64>,
}

/// Id given to the single question of experiments created before multi-question support.
pub const LEGACY_TASK_ID: &str = "label";

fn default_task_id() -> String {
    LEGACY_TASK_ID.to_string()
}

/// Ollaya accepts at most 256 questions per request.
pub const MAX_PRIMITIVE_QUESTIONS: usize = 256;
pub const MAX_TASKS: usize = 64;

/// Several questions over the same rows, asked together in one request per (model, row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "RawExperimentConfig")]
pub struct ExperimentConfig {
    pub name: String,
    pub dataset_id: String,
    /// Shared by every question: one column is sent as a string, several as a JSON object.
    pub input_columns: Vec<String>,
    /// Context shared by every question.
    pub context: Option<String>,
    pub tasks: Vec<TaskSpec>,
    pub models: Vec<String>,
    /// Evaluate a deterministic random sample of this many rows; all rows when absent.
    pub sample_size: Option<usize>,
    /// Parallel requests per model. Default 4.
    pub concurrency: Option<usize>,
}

/// Accepts the current shape and the single-task shape stored by earlier versions
/// (`task: { input_columns, ... }`).
#[derive(Deserialize)]
struct RawExperimentConfig {
    name: String,
    dataset_id: String,
    #[serde(default)]
    input_columns: Vec<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    tasks: Vec<TaskSpec>,
    #[serde(default)]
    task: Option<LegacyTask>,
    models: Vec<String>,
    #[serde(default)]
    sample_size: Option<usize>,
    #[serde(default)]
    concurrency: Option<usize>,
}

#[derive(Deserialize)]
struct LegacyTask {
    #[serde(default)]
    input_columns: Vec<String>,
    #[serde(flatten)]
    spec: TaskSpec,
}

impl From<RawExperimentConfig> for ExperimentConfig {
    fn from(r: RawExperimentConfig) -> Self {
        let (mut tasks, mut input_columns) = (r.tasks, r.input_columns);
        if let (true, Some(legacy)) = (tasks.is_empty(), r.task) {
            if input_columns.is_empty() {
                input_columns = legacy.input_columns;
            }
            tasks = vec![TaskSpec { id: LEGACY_TASK_ID.into(), ..legacy.spec }];
        }
        Self {
            name: r.name,
            dataset_id: r.dataset_id,
            input_columns,
            context: r.context,
            tasks,
            models: r.models,
            sample_size: r.sample_size,
            concurrency: r.concurrency,
        }
    }
}

impl ExperimentConfig {
    pub fn validate(&self) -> Result<()> {
        if self.input_columns.is_empty() {
            return Err(Error::invalid("pick at least one input column"));
        }
        if self.tasks.is_empty() {
            return Err(Error::invalid("add at least one question"));
        }
        if self.tasks.len() > MAX_TASKS {
            return Err(Error::invalid(format!("at most {MAX_TASKS} questions per experiment")));
        }
        let mut seen = std::collections::HashSet::new();
        for t in &self.tasks {
            t.validate()?;
            if !seen.insert(t.id.trim()) {
                return Err(Error::invalid(format!("question id \"{}\" is used twice", t.id)));
            }
            if self.input_columns.contains(&t.label_column) {
                return Err(Error::invalid(format!(
                    "{}: the ground-truth column \"{}\" cannot also be an input",
                    t.id, t.label_column
                )));
            }
        }
        // Every task is one primitive question today; kept explicit for future expanded kinds.
        if self.tasks.len() > MAX_PRIMITIVE_QUESTIONS {
            return Err(Error::invalid(format!("at most {MAX_PRIMITIVE_QUESTIONS} model questions per request")));
        }
        if self.models.is_empty() {
            return Err(Error::invalid("pick at least one model"));
        }
        Ok(())
    }

    pub fn task(&self, id: &str) -> Option<&TaskSpec> {
        self.tasks.iter().find(|t| t.id == id)
    }

    /// All questions, keyed by task id, for one decide request.
    pub fn questions(&self) -> IndexMap<String, Question> {
        self.tasks.iter().map(|t| (t.id.clone(), t.question(self.context.as_deref()))).collect()
    }

    pub fn state(&self, row: &Row) -> Value {
        state(&self.input_columns, row)
    }

    /// A row is worth asking when at least one question has a ground truth for it.
    pub fn has_ground_truth(&self, row: &Row) -> bool {
        self.tasks.iter().any(|t| t.ground_truth(row).is_some())
    }
}

/// One input column becomes a plain string state; several become a JSON object.
pub fn state(input_columns: &[String], row: &Row) -> Value {
    if let [col] = input_columns {
        return Value::String(row.get(col).cloned().unwrap_or_default());
    }
    let obj = input_columns
        .iter()
        .map(|c| (c.clone(), Value::String(row.get(c).cloned().unwrap_or_default())))
        .collect();
    Value::Object(obj)
}

/// The instructions sent to the model: `"{instructions}\n\nContext: {shared}\n{question}"`, with
/// empty contexts left out (and no context section when both are empty). The result is trimmed.
pub fn compose_instructions(instructions: &str, shared_context: Option<&str>, question_context: Option<&str>) -> String {
    let contexts: Vec<&str> =
        [shared_context, question_context].into_iter().flatten().map(str::trim).filter(|c| !c.is_empty()).collect();
    if contexts.is_empty() {
        return instructions.trim().to_string();
    }
    format!("{}\n\nContext: {}", instructions.trim(), contexts.join("\n")).trim().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interpreted {
    pub predicted: String,
    /// TypeSafe-normalized confidence: 0 = uniform, 1 = certain.
    pub confidence: f64,
    /// Probability of the predicted label (used for calibration).
    pub top_prob: f64,
    pub probabilities: IndexMap<String, f64>,
}

impl TaskSpec {
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(Error::invalid("every question needs an id"));
        }
        let id = &self.id;
        match self.kind {
            TaskKind::Choice if !(2..=255).contains(&self.labels.len()) => {
                Err(Error::invalid(format!("{id}: a choice question needs 2 to 255 labels")))
            }
            TaskKind::Binary if self.labels.len() != 2 => {
                Err(Error::invalid(format!("{id}: a binary question needs exactly 2 labels")))
            }
            TaskKind::Binary if self.positive().is_none() => {
                Err(Error::invalid(format!("{id}: pick which label counts as positive")))
            }
            _ => Ok(()),
        }
    }

    fn positive(&self) -> Option<&LabelSpec> {
        let p = self.positive_label.as_deref()?;
        self.labels.iter().find(|l| l.value == p)
    }

    fn negative(&self) -> Option<&LabelSpec> {
        let p = self.positive_label.as_deref()?;
        self.labels.iter().find(|l| l.value != p)
    }

    pub fn label_values(&self) -> Vec<String> {
        self.labels.iter().map(|l| l.value.clone()).collect()
    }

    /// The Ollaya question, with the experiment's shared context and this question's own.
    pub fn question(&self, shared_context: Option<&str>) -> Question {
        let instructions = Some(compose_instructions(&self.instructions, shared_context, self.context.as_deref()))
            .filter(|s| !s.is_empty());
        match self.kind {
            TaskKind::Choice => Question::Choice {
                instructions,
                criteria: self
                    .labels
                    .iter()
                    .map(|l| (l.value.clone(), l.description.clone().filter(|d| !d.trim().is_empty())))
                    .collect(),
            },
            TaskKind::Binary => Question::Noul {
                instructions,
                criteria: Some(NoulCriteria {
                    when_true: self.positive().map(describe),
                    when_false: self.negative().map(describe),
                }),
            },
        }
    }

    pub fn ground_truth(&self, row: &Row) -> Option<String> {
        let v = row.get(&self.label_column)?.trim().to_string();
        self.labels.iter().any(|l| l.value == v).then_some(v)
    }

    pub fn interpret(&self, answer: &Answer) -> Result<Interpreted> {
        match (self.kind, answer) {
            (TaskKind::Choice, Answer::Choice { choice, confidence, probabilities }) => Ok(Interpreted {
                predicted: choice.clone(),
                confidence: *confidence,
                top_prob: answer.top_probability(),
                probabilities: probabilities.clone(),
            }),
            (TaskKind::Binary, Answer::Noul { noul }) => {
                let pos = self.positive().ok_or_else(|| Error::invalid("no positive label"))?;
                let neg = self.negative().ok_or_else(|| Error::invalid("no negative label"))?;
                let threshold = self.threshold.unwrap_or(0.5);
                let predicted = if *noul >= threshold { &pos.value } else { &neg.value };
                let mut probabilities = IndexMap::new();
                probabilities.insert(pos.value.clone(), *noul);
                probabilities.insert(neg.value.clone(), 1.0 - noul);
                Ok(Interpreted {
                    predicted: predicted.clone(),
                    confidence: (2.0 * noul - 1.0).abs(),
                    top_prob: answer.top_probability(),
                    probabilities,
                })
            }
            _ => Err(Error::invalid("model returned an answer of the wrong type")),
        }
    }
}

fn describe(l: &LabelSpec) -> String {
    l.description.clone().filter(|d| !d.trim().is_empty()).unwrap_or_else(|| l.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binary() -> TaskSpec {
        TaskSpec {
            id: "spam".into(),
            kind: TaskKind::Binary,
            instructions: "Is this spam?".into(),
            context: None,
            label_column: "label".into(),
            labels: vec![
                LabelSpec { value: "spam".into(), description: None },
                LabelSpec { value: "ham".into(), description: Some("A normal message".into()) },
            ],
            positive_label: Some("spam".into()),
            threshold: None,
        }
    }

    fn config(tasks: Vec<TaskSpec>) -> ExperimentConfig {
        ExperimentConfig {
            name: "e".into(),
            dataset_id: "d".into(),
            input_columns: vec!["text".into()],
            context: None,
            tasks,
            models: vec!["laya".into()],
            sample_size: None,
            concurrency: None,
        }
    }

    #[test]
    fn binary_question_and_interpretation() {
        let t = binary();
        t.validate().unwrap();
        let q = serde_json::to_value(t.question(None)).unwrap();
        assert_eq!(q["instructions"], "Is this spam?");
        assert_eq!(q["criteria"]["true"], "spam");
        assert_eq!(q["criteria"]["false"], "A normal message");
        let i = t.interpret(&Answer::Noul { noul: 0.2 }).unwrap();
        assert_eq!(i.predicted, "ham");
        assert!((i.top_prob - 0.8).abs() < 1e-9);
    }

    #[test]
    fn multi_column_state_is_object() {
        let t = binary();
        let row: Row = [("subject", "Hi"), ("body", "Win now"), ("label", " spam ")]
            .into_iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let cols = vec!["subject".to_string(), "body".to_string()];
        assert_eq!(state(&cols, &row), serde_json::json!({"subject":"Hi","body":"Win now"}));
        assert_eq!(state(&cols[1..], &row), serde_json::json!("Win now"));
        assert_eq!(t.ground_truth(&row).as_deref(), Some("spam"));
    }

    #[test]
    fn instructions_with_context() {
        assert_eq!(compose_instructions(" Is it spam? ", None, Some("  ")), "Is it spam?");
        assert_eq!(compose_instructions("Is it spam?", Some(" SMS "), None), "Is it spam?\n\nContext: SMS");
        assert_eq!(
            compose_instructions("Is it spam?", Some("SMS"), Some("Promotions count as spam.")),
            "Is it spam?\n\nContext: SMS\nPromotions count as spam."
        );
        assert_eq!(compose_instructions("", None, Some("x")), "Context: x");
        assert_eq!(compose_instructions(" ", None, None), "");

        let mut t = binary();
        t.context = Some("Promotions count as spam.".into());
        let q = serde_json::to_value(t.question(Some("SMS messages"))).unwrap();
        assert_eq!(q["instructions"], "Is this spam?\n\nContext: SMS messages\nPromotions count as spam.");
        t.instructions = " ".into();
        t.context = None;
        assert!(matches!(t.question(None), Question::Noul { instructions: None, .. }));
    }

    #[test]
    fn legacy_config_becomes_one_task() {
        let json = serde_json::json!({
            "name": "old", "dataset_id": "d",
            "task": {
                "kind": "binary", "instructions": "Is this spam?", "input_columns": ["subject", "body"],
                "label_column": "label", "labels": [{"value": "spam"}, {"value": "ham"}],
                "positive_label": "spam", "threshold": 0.7
            },
            "models": ["laya"], "sample_size": null, "concurrency": 2
        });
        let c: ExperimentConfig = serde_json::from_value(json).unwrap();
        c.validate().unwrap();
        assert_eq!(c.input_columns, vec!["subject", "body"]);
        assert_eq!(c.tasks.len(), 1);
        assert_eq!(c.tasks[0].id, LEGACY_TASK_ID);
        assert_eq!(c.tasks[0].threshold, Some(0.7));
        assert_eq!(c.concurrency, Some(2));

        let out = serde_json::to_value(&c).unwrap();
        assert!(out.get("task").is_none());
        assert_eq!(out["tasks"][0]["id"], "label");
        assert!(out["tasks"][0].get("input_columns").is_none());
        // the new shape round-trips
        let again: ExperimentConfig = serde_json::from_value(out).unwrap();
        assert_eq!(again.tasks[0].label_column, "label");
        assert_eq!(again.input_columns, c.input_columns);
    }

    #[test]
    fn config_validation() {
        let mut team = binary();
        team.id = "team".into();
        team.kind = TaskKind::Choice;
        team.label_column = "team".into();
        let mut c = config(vec![binary(), team.clone()]);
        c.validate().unwrap();
        assert_eq!(c.questions().keys().collect::<Vec<_>>(), vec!["spam", "team"]);

        c.tasks[1].id = "spam".into();
        assert!(c.validate().is_err(), "duplicate ids");
        c.tasks[1].id = " ".into();
        assert!(c.validate().is_err(), "empty id");
        c.tasks[1] = team;
        c.input_columns.push("team".into());
        assert!(c.validate().is_err(), "label column used as input");
        c.input_columns.clear();
        assert!(c.validate().is_err(), "no input");
        let mut c = config(vec![]);
        assert!(c.validate().is_err(), "no tasks");
        c.tasks = (0..65).map(|i| TaskSpec { id: format!("q{i}"), ..binary() }).collect();
        assert!(c.validate().is_err(), "too many tasks");
        c.tasks.truncate(64);
        c.validate().unwrap();
        c.models.clear();
        assert!(c.validate().is_err(), "no models");
    }
}
