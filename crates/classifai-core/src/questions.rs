//! Extended question types built from Ollaya's three primitives (`choice`, `score`, `noul`).
//!
//! | Extended | Sent to the model as | Answer |
//! |---|---|---|
//! | `multi` (pick any) | one `noul` per option | options whose P(applies) ≥ threshold |
//! | `rank` | one `choice` | options ordered by probability |
//! | `number` | `score` over the values (≤ 10), else `choice` | expected value, most likely value, 80% range |
//!
//! [`expand`] turns a question set into primitive questions plus a [`Plan`]; [`assemble`] folds the
//! primitive answers back. Primitive questions pass through unchanged.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::ollaya::{Answer, NoulCriteria, Question};
use crate::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AnyQuestion {
    Choice {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        criteria: IndexMap<String, Option<String>>,
    },
    Score {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        criteria: Vec<String>,
    },
    Noul {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        criteria: Option<NoulCriteria>,
    },
    /// Pick all options that apply.
    Multi {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        criteria: IndexMap<String, Option<String>>,
        /// P(applies) cut-off, default 0.5
        #[serde(default, skip_serializing_if = "Option::is_none")]
        threshold: Option<f64>,
    },
    /// Order the options from most to least fitting.
    Rank {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        criteria: IndexMap<String, Option<String>>,
    },
    /// Estimate a number from a set of candidate values.
    Number {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        values: Vec<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AnyAnswer {
    Choice {
        choice: String,
        confidence: f64,
        probabilities: IndexMap<String, f64>,
    },
    Score {
        score: f64,
        confidence: f64,
        legend: IndexMap<String, String>,
        probabilities: IndexMap<String, f64>,
    },
    Noul {
        noul: f64,
    },
    Multi {
        selected: Vec<String>,
        threshold: f64,
        /// option -> P(applies), in the caller's option order
        probabilities: IndexMap<String, f64>,
    },
    Rank {
        ranking: Vec<String>,
        confidence: f64,
        probabilities: IndexMap<String, f64>,
    },
    Number {
        estimate: f64,
        most_likely: f64,
        /// central 80% interval [p10, p90] over the candidate values
        range: [f64; 2],
        unit: Option<String>,
        confidence: f64,
        /// formatted value -> probability, ascending
        probabilities: IndexMap<String, f64>,
    },
}

impl From<Answer> for AnyAnswer {
    fn from(a: Answer) -> Self {
        match a {
            Answer::Choice { choice, confidence, probabilities } => AnyAnswer::Choice { choice, confidence, probabilities },
            Answer::Score { score, confidence, legend, probabilities } => {
                AnyAnswer::Score { score, confidence, legend, probabilities }
            }
            Answer::Noul { noul } => AnyAnswer::Noul { noul },
        }
    }
}

/// How to fold primitive answers back into one extended answer.
#[derive(Debug, Clone)]
enum Step {
    Pass { id: String },
    Multi { id: String, threshold: f64, children: Vec<(String, String)> },
    Rank { id: String },
    Number { id: String, values: Vec<f64>, unit: Option<String> },
}

#[derive(Debug, Clone)]
pub struct Plan(Vec<Step>);

/// Ollaya accepts at most 256 questions per request.
const MAX_PRIMITIVES: usize = 256;

pub fn expand(questions: &IndexMap<String, AnyQuestion>) -> Result<(IndexMap<String, Question>, Plan)> {
    let mut out = IndexMap::new();
    let mut plan = Vec::new();
    for (id, q) in questions {
        match q {
            AnyQuestion::Choice { instructions, criteria } => {
                out.insert(id.clone(), Question::Choice { instructions: instructions.clone(), criteria: criteria.clone() });
                plan.push(Step::Pass { id: id.clone() });
            }
            AnyQuestion::Score { instructions, criteria } => {
                out.insert(id.clone(), Question::Score { instructions: instructions.clone(), criteria: criteria.clone() });
                plan.push(Step::Pass { id: id.clone() });
            }
            AnyQuestion::Noul { instructions, criteria } => {
                out.insert(id.clone(), Question::Noul { instructions: instructions.clone(), criteria: criteria.clone() });
                plan.push(Step::Pass { id: id.clone() });
            }
            AnyQuestion::Multi { instructions, criteria, threshold } => {
                if criteria.is_empty() {
                    return Err(Error::invalid(format!("{id}: a pick-any question needs at least one option")));
                }
                let threshold = threshold.unwrap_or(0.5);
                if !(0.0..1.0).contains(&threshold) || threshold == 0.0 {
                    return Err(Error::invalid(format!("{id}: threshold must be between 0 and 1")));
                }
                let mut children = Vec::new();
                for (i, (option, desc)) in criteria.iter().enumerate() {
                    let child = format!("{id}__multi{i}");
                    let desc = desc.as_deref().map(str::trim).filter(|d| !d.is_empty());
                    // noul instructions are a statement; the model returns P(statement holds).
                    let statement = match desc {
                        Some(d) => format!("\"{option}\" applies ({d})."),
                        None => format!("\"{option}\" applies."),
                    };
                    let statement = match instructions.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                        Some(ctx) => format!("{ctx}\n{statement}"),
                        None => statement,
                    };
                    out.insert(child.clone(), Question::Noul { instructions: Some(statement), criteria: None });
                    children.push((option.clone(), child));
                }
                plan.push(Step::Multi { id: id.clone(), threshold, children });
            }
            AnyQuestion::Rank { instructions, criteria } => {
                if criteria.len() < 2 {
                    return Err(Error::invalid(format!("{id}: a rank question needs at least two options")));
                }
                out.insert(id.clone(), Question::Choice { instructions: instructions.clone(), criteria: criteria.clone() });
                plan.push(Step::Rank { id: id.clone() });
            }
            AnyQuestion::Number { instructions, values, unit } => {
                let mut vals: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
                vals.sort_by(|a, b| a.total_cmp(b));
                vals.dedup();
                if vals.len() < 2 {
                    return Err(Error::invalid(format!("{id}: a number question needs at least two distinct values")));
                }
                if vals.len() > 255 {
                    return Err(Error::invalid(format!("{id}: at most 255 candidate values")));
                }
                let labels: Vec<String> = vals.iter().map(|v| label_for(*v, unit.as_deref())).collect();
                // A score is ordinal, which suits numbers; Ollaya allows 2–10 levels. Beyond that a
                // choice over the values still yields a distribution.
                let q = if vals.len() <= 10 {
                    Question::Score { instructions: instructions.clone(), criteria: labels }
                } else {
                    Question::Choice { instructions: instructions.clone(), criteria: labels.into_iter().map(|l| (l, None)).collect() }
                };
                out.insert(id.clone(), q);
                plan.push(Step::Number { id: id.clone(), values: vals, unit: unit.clone() });
            }
        }
    }
    if out.len() > MAX_PRIMITIVES {
        return Err(Error::invalid(format!(
            "these questions expand to {} model questions; the limit is {MAX_PRIMITIVES} (pick-any asks one per option)",
            out.len()
        )));
    }
    Ok((out, Plan(plan)))
}

pub fn assemble(plan: &Plan, answers: IndexMap<String, Answer>) -> Result<IndexMap<String, AnyAnswer>> {
    Ok(assemble_except(plan, answers, &[])?.0)
}

/// Like [`assemble`], but questions that depend on a `refused` primitive are left out and
/// returned as the second value (by their own id).
pub fn assemble_except(
    plan: &Plan,
    mut answers: IndexMap<String, Answer>,
    refused: &[String],
) -> Result<(IndexMap<String, AnyAnswer>, Vec<String>)> {
    let missing = |id: &str| Error::invalid(format!("answer for {id} missing from the response"));
    let mut out = IndexMap::new();
    let mut skipped = Vec::new();
    for step in &plan.0 {
        let (id, primitives): (&String, Vec<&String>) = match step {
            Step::Pass { id } | Step::Rank { id } | Step::Number { id, .. } => (id, vec![id]),
            Step::Multi { id, children, .. } => (id, children.iter().map(|(_, c)| c).collect()),
        };
        if primitives.iter().any(|p| refused.contains(p)) {
            skipped.push(id.clone());
            continue;
        }
        match step {
            Step::Pass { id } => {
                let a = answers.shift_remove(id).ok_or_else(|| missing(id))?;
                out.insert(id.clone(), a.into());
            }
            Step::Multi { id, threshold, children } => {
                let mut probabilities = IndexMap::new();
                let mut selected = Vec::new();
                for (option, child) in children {
                    let p = match answers.shift_remove(child).ok_or_else(|| missing(child))? {
                        Answer::Noul { noul } => noul,
                        _ => return Err(Error::invalid(format!("{id}: expected a yes/no answer"))),
                    };
                    if p >= *threshold {
                        selected.push(option.clone());
                    }
                    probabilities.insert(option.clone(), p);
                }
                out.insert(id.clone(), AnyAnswer::Multi { selected, threshold: *threshold, probabilities });
            }
            Step::Rank { id } => match answers.shift_remove(id).ok_or_else(|| missing(id))? {
                Answer::Choice { confidence, probabilities, .. } => {
                    let mut ranking: Vec<String> = probabilities.keys().cloned().collect();
                    ranking.sort_by(|a, b| probabilities[b].total_cmp(&probabilities[a]));
                    out.insert(id.clone(), AnyAnswer::Rank { ranking, confidence, probabilities });
                }
                _ => return Err(Error::invalid(format!("{id}: expected a choice answer"))),
            },
            Step::Number { id, values, unit } => {
                let (probs, confidence): (Vec<f64>, f64) = match answers.shift_remove(id).ok_or_else(|| missing(id))? {
                    // Ollaya keys score levels "0", "1", … and choices by label, both in our order.
                    Answer::Score { probabilities, confidence, .. } | Answer::Choice { probabilities, confidence, .. } => {
                        (probabilities.values().copied().collect(), confidence)
                    }
                    _ => return Err(Error::invalid(format!("{id}: expected a scale answer"))),
                };
                if probs.len() != values.len() {
                    return Err(Error::invalid(format!("{id}: answer has {} levels, expected {}", probs.len(), values.len())));
                }
                let total: f64 = probs.iter().sum::<f64>().max(1e-12);
                let p: Vec<f64> = probs.iter().map(|x| x / total).collect();
                let estimate = values.iter().zip(&p).map(|(v, x)| v * x).sum();
                let mode = p.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, _)| values[i]).unwrap_or(values[0]);
                let range = [quantile(values, &p, 0.1), quantile(values, &p, 0.9)];
                let probabilities = values.iter().zip(&p).map(|(v, x)| (fmt_num(*v), *x)).collect();
                out.insert(
                    id.clone(),
                    AnyAnswer::Number { estimate, most_likely: mode, range, unit: unit.clone(), confidence, probabilities },
                );
            }
        }
    }
    Ok((out, skipped))
}

/// Smallest value whose cumulative probability reaches `q`.
fn quantile(values: &[f64], p: &[f64], q: f64) -> f64 {
    let mut acc = 0.0;
    for (v, x) in values.iter().zip(p) {
        acc += x;
        if acc + 1e-9 >= q {
            return *v;
        }
    }
    *values.last().unwrap_or(&0.0)
}

pub fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        let s = format!("{v:.6}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn label_for(v: f64, unit: Option<&str>) -> String {
    match unit.map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => format!("{} {u}", fmt_num(v)),
        None => fmt_num(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crit(xs: &[&str]) -> IndexMap<String, Option<String>> {
        xs.iter().map(|x| (x.to_string(), None)).collect()
    }

    #[test]
    fn multi_expands_to_one_noul_per_option_and_thresholds() {
        let mut qs = IndexMap::new();
        qs.insert(
            "topics".to_string(),
            AnyQuestion::Multi { instructions: Some("Which topics are covered?".into()), criteria: crit(&["a", "b", "c"]), threshold: Some(0.6) },
        );
        let (prim, plan) = expand(&qs).unwrap();
        assert_eq!(prim.len(), 3);
        assert!(matches!(&prim["topics__multi1"], Question::Noul { instructions: Some(s), .. } if s.contains("\"b\" applies")));
        let answers: IndexMap<String, Answer> = [("topics__multi0", 0.9), ("topics__multi1", 0.2), ("topics__multi2", 0.6)]
            .into_iter()
            .map(|(k, p)| (k.to_string(), Answer::Noul { noul: p }))
            .collect();
        match &assemble(&plan, answers).unwrap()["topics"] {
            AnyAnswer::Multi { selected, .. } => assert_eq!(selected, &vec!["a".to_string(), "c".to_string()]),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rank_orders_by_probability() {
        let mut qs = IndexMap::new();
        qs.insert("r".to_string(), AnyQuestion::Rank { instructions: None, criteria: crit(&["x", "y", "z"]) });
        let (prim, plan) = expand(&qs).unwrap();
        assert!(matches!(prim["r"], Question::Choice { .. }));
        let probs: IndexMap<String, f64> = [("x", 0.2), ("y", 0.5), ("z", 0.3)].into_iter().map(|(k, v)| (k.into(), v)).collect();
        let mut answers = IndexMap::new();
        answers.insert("r".to_string(), Answer::Choice { choice: "y".into(), confidence: 0.25, probabilities: probs });
        match &assemble(&plan, answers).unwrap()["r"] {
            AnyAnswer::Rank { ranking, .. } => assert_eq!(ranking, &vec!["y".to_string(), "z".into(), "x".into()]),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn number_uses_score_and_computes_estimate_and_range() {
        let mut qs = IndexMap::new();
        qs.insert(
            "n".to_string(),
            AnyQuestion::Number { instructions: None, values: vec![30.0, 10.0, 20.0, 20.0], unit: Some("min".into()) },
        );
        let (prim, plan) = expand(&qs).unwrap();
        match &prim["n"] {
            Question::Score { criteria, .. } => assert_eq!(criteria, &vec!["10 min".to_string(), "20 min".into(), "30 min".into()]),
            other => panic!("{other:?}"),
        }
        let probs: IndexMap<String, f64> = [("0", 0.1), ("1", 0.6), ("2", 0.3)].into_iter().map(|(k, v)| (k.into(), v)).collect();
        let mut answers = IndexMap::new();
        answers.insert(
            "n".to_string(),
            Answer::Score { score: 1.2, confidence: 0.4, legend: IndexMap::new(), probabilities: probs },
        );
        match &assemble(&plan, answers).unwrap()["n"] {
            AnyAnswer::Number { estimate, most_likely, range, .. } => {
                assert!((estimate - 22.0).abs() < 1e-9);
                assert_eq!(*most_likely, 20.0);
                assert_eq!(*range, [10.0, 30.0]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn many_number_values_fall_back_to_choice() {
        let mut qs = IndexMap::new();
        qs.insert("n".to_string(), AnyQuestion::Number { instructions: None, values: (0..20).map(f64::from).collect(), unit: None });
        let (prim, _) = expand(&qs).unwrap();
        assert!(matches!(prim["n"], Question::Choice { .. }));
    }

    #[test]
    fn refused_primitives_skip_their_question() {
        let mut qs = IndexMap::new();
        qs.insert("topics".to_string(), AnyQuestion::Multi { instructions: None, criteria: crit(&["a", "b"]), threshold: None });
        qs.insert("q".to_string(), AnyQuestion::Noul { instructions: Some("?".into()), criteria: None });
        let (_, plan) = expand(&qs).unwrap();
        let mut answers = IndexMap::new();
        answers.insert("topics__multi0".to_string(), Answer::Noul { noul: 0.9 });
        answers.insert("q".to_string(), Answer::Noul { noul: 0.2 });
        let (out, skipped) = assemble_except(&plan, answers.clone(), &["topics__multi1".to_string()]).unwrap();
        assert_eq!(skipped, vec!["topics"]);
        assert_eq!(out.keys().collect::<Vec<_>>(), vec!["q"]);
        assert!(assemble(&plan, answers).is_err(), "without the refusal it is a missing answer");
    }

    #[test]
    fn primitives_pass_through() {
        let json = serde_json::json!({"q": {"type": "noul", "instructions": "Is it spam?"}});
        let qs: IndexMap<String, AnyQuestion> = serde_json::from_value(json).unwrap();
        let (prim, plan) = expand(&qs).unwrap();
        assert_eq!(serde_json::to_value(&prim).unwrap(), serde_json::json!({"q": {"type": "noul", "instructions": "Is it spam?"}}));
        let mut answers = IndexMap::new();
        answers.insert("q".to_string(), Answer::Noul { noul: 0.3 });
        assert_eq!(assemble(&plan, answers).unwrap()["q"], AnyAnswer::Noul { noul: 0.3 });
    }
}
