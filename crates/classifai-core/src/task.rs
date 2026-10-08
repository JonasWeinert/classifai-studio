//! A classification task: which columns form the input, which column is ground truth, and how
//! ground-truth labels map onto an Ollaya question.

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
    pub kind: TaskKind,
    /// The question text, e.g. "What is the sentiment of this review?"
    pub instructions: String,
    pub input_columns: Vec<String>,
    pub label_column: String,
    pub labels: Vec<LabelSpec>,
    /// Binary only: the label that counts as `true`.
    #[serde(default)]
    pub positive_label: Option<String>,
    /// Binary only: P(true) at or above this is predicted positive. Default 0.5.
    #[serde(default)]
    pub threshold: Option<f64>,
}

pub const QUESTION_ID: &str = "label";

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
        if self.input_columns.is_empty() {
            return Err(Error::invalid("pick at least one input column"));
        }
        if self.input_columns.contains(&self.label_column) {
            return Err(Error::invalid("the ground-truth column cannot also be an input"));
        }
        match self.kind {
            TaskKind::Choice if !(2..=255).contains(&self.labels.len()) => {
                Err(Error::invalid("a choice task needs 2 to 255 labels"))
            }
            TaskKind::Binary if self.labels.len() != 2 => {
                Err(Error::invalid("a binary task needs exactly 2 labels"))
            }
            TaskKind::Binary if self.positive().is_none() => {
                Err(Error::invalid("pick which label counts as positive"))
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

    pub fn question(&self) -> Question {
        let instructions = Some(self.instructions.trim().to_string()).filter(|s| !s.is_empty());
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

    pub fn questions(&self) -> IndexMap<String, Question> {
        let mut m = IndexMap::new();
        m.insert(QUESTION_ID.to_string(), self.question());
        m
    }

    /// One input column becomes a plain string state; several become a JSON object.
    pub fn state(&self, row: &Row) -> Value {
        if let [col] = self.input_columns.as_slice() {
            return Value::String(row.get(col).cloned().unwrap_or_default());
        }
        let obj = self
            .input_columns
            .iter()
            .map(|c| (c.clone(), Value::String(row.get(c).cloned().unwrap_or_default())))
            .collect();
        Value::Object(obj)
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
            kind: TaskKind::Binary,
            instructions: "Is this spam?".into(),
            input_columns: vec!["text".into()],
            label_column: "label".into(),
            labels: vec![
                LabelSpec { value: "spam".into(), description: None },
                LabelSpec { value: "ham".into(), description: Some("A normal message".into()) },
            ],
            positive_label: Some("spam".into()),
            threshold: None,
        }
    }

    #[test]
    fn binary_question_and_interpretation() {
        let t = binary();
        t.validate().unwrap();
        let q = serde_json::to_value(t.question()).unwrap();
        assert_eq!(q["criteria"]["true"], "spam");
        assert_eq!(q["criteria"]["false"], "A normal message");
        let i = t.interpret(&Answer::Noul { noul: 0.2 }).unwrap();
        assert_eq!(i.predicted, "ham");
        assert!((i.top_prob - 0.8).abs() < 1e-9);
    }

    #[test]
    fn multi_column_state_is_object() {
        let mut t = binary();
        t.input_columns = vec!["subject".into(), "body".into()];
        let row: Row = [("subject", "Hi"), ("body", "Win now"), ("label", " spam ")]
            .into_iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        assert_eq!(t.state(&row), serde_json::json!({"subject":"Hi","body":"Win now"}));
        assert_eq!(t.ground_truth(&row).as_deref(), Some("spam"));
    }
}
