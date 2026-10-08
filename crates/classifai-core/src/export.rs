//! A written report of one experiment, as Markdown or self-contained HTML: setup, questions,
//! models, per-question metrics with confusion matrices and agreement, human corrections, cost,
//! and an auto-written methods paragraph.

use crate::analysis;
use crate::eval::Report;
use crate::providers::{parse_model_id, ModelRef};
use crate::runner::SAMPLE_SEED;
use crate::store::{Experiment, LabelCorrection, Store, UsageRow};
use crate::task::{TaskKind, TaskSpec};
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Html,
}

impl Format {
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "md" | "markdown" => Ok(Self::Markdown),
            "html" | "htm" => Ok(Self::Html),
            other => Err(Error::invalid(format!("unknown report format \"{other}\"; use md or html"))),
        }
    }
}

/// Build the report and write it to `path`.
pub fn write_report(store: &Store, experiment_id: &str, path: &str, format: Format) -> Result<String> {
    let text = render_report(store, experiment_id, format)?;
    std::fs::write(path, text)?;
    Ok(path.to_string())
}

pub fn render_report(store: &Store, experiment_id: &str, format: Format) -> Result<String> {
    let e = store.get_experiment(experiment_id)?;
    let dataset = store.get_dataset(&e.dataset_id)?;
    let reports = analysis::reports(store, &e)?;
    let corrections = store.label_corrections(&e.dataset_id)?;
    let usage = store.experiment_usage(&e.id)?;
    let doc = build(&e, &dataset.name, dataset.row_count, &reports, &corrections, &usage);
    Ok(match format {
        Format::Markdown => to_markdown(&doc),
        Format::Html => to_html(&e.name, &doc),
    })
}

// ---- document model -----------------------------------------------------------------------

enum Block {
    Heading(u8, String),
    Para(String),
    List(Vec<String>),
    Table { head: Vec<String>, rows: Vec<Vec<String>> },
}

fn f3(v: f64) -> String {
    format!("{v:.3}")
}

fn kind_name(k: TaskKind) -> &'static str {
    match k {
        TaskKind::Choice => "choice (one label)",
        TaskKind::Binary => "binary (yes/no with threshold)",
    }
}

fn model_kind(m: &str) -> String {
    match parse_model_id(m) {
        Ok(ModelRef::Cloud { provider, .. }) => format!("cloud, provider {provider}"),
        _ => "local (Ollaya)".into(),
    }
}

fn sampling_statement(e: &Experiment) -> String {
    match e.config.sample_size {
        Some(k) if k > 0 && e.row_indices.len() == k => format!(
            "a deterministic random sample of {k} rows (Fisher–Yates shuffle with xorshift64, seed 0x{SAMPLE_SEED:X}) drawn from the rows with a usable ground truth; re-creating the experiment selects the same rows"
        ),
        _ => "all rows with a usable ground truth (no sampling)".into(),
    }
}

fn question_corrections<'a>(e: &Experiment, task: &TaskSpec, all: &'a [LabelCorrection]) -> Vec<&'a LabelCorrection> {
    let rows: std::collections::HashSet<usize> = e.row_indices.iter().copied().collect();
    all.iter().filter(|c| c.column == task.label_column && rows.contains(&c.row_idx)).collect()
}

fn build(
    e: &Experiment,
    dataset_name: &str,
    dataset_rows: usize,
    reports: &[Report],
    corrections: &[LabelCorrection],
    usage: &[UsageRow],
) -> Vec<Block> {
    use Block::*;
    let cfg = &e.config;
    let mut d = vec![
        Heading(1, format!("{} — classification report", e.name)),
        Para(format!(
            "Generated {} by ClassifAI {}. Experiment {} ({:?}, created {}).",
            chrono::Local::now().format("%Y-%m-%d %H:%M"),
            env!("CARGO_PKG_VERSION"),
            e.id,
            e.status,
            e.created_at
        )),
        Heading(2, "Data".into()),
        List(vec![
            format!("Dataset: {dataset_name} ({dataset_rows} rows)"),
            format!("Rows evaluated: {} — {}", e.row_indices.len(), sampling_statement(e)),
            format!("Input columns: {}", cfg.input_columns.join(", ")),
            format!(
                "Shared context: {}",
                cfg.context.as_deref().map(str::trim).filter(|c| !c.is_empty()).unwrap_or("none")
            ),
        ]),
        Heading(2, "Questions".into()),
    ];
    for t in &cfg.tasks {
        d.push(Heading(3, t.id.clone()));
        let mut items = vec![
            format!("Instructions: {}", t.instructions.trim()),
            format!("Context: {}", t.context.as_deref().map(str::trim).filter(|c| !c.is_empty()).unwrap_or("none")),
            format!("Kind: {}", kind_name(t.kind)),
            format!("Ground-truth column: {}", t.label_column),
        ];
        if t.kind == TaskKind::Binary {
            items.push(format!("Positive label: {}", t.positive_label.as_deref().unwrap_or("-")));
            items.push(format!("Threshold: {:.2}", t.threshold.unwrap_or(0.5)));
        }
        d.push(List(items));
        d.push(Table {
            head: vec!["Label".into(), "Description".into(), "Aliases".into()],
            rows: t
                .labels
                .iter()
                .map(|l| vec![l.value.clone(), l.description.clone().unwrap_or_default(), l.aliases.join(", ")])
                .collect(),
        });
    }
    d.push(Heading(2, "Models".into()));
    d.push(List(cfg.models.iter().map(|m| format!("{m} ({})", model_kind(m))).collect()));

    d.push(Heading(2, "Results".into()));
    for r in reports {
        let Some(task) = cfg.task(&r.question_id) else { continue };
        let qc = question_corrections(e, task, corrections);
        d.push(Heading(3, format!("Question: {}", r.question_id)));
        d.push(Table {
            head: ["Model", "Accuracy", "Macro F1", "Weighted F1", "κ", "ECE", "p50 latency (ms)", "Errors", "Scored rows"]
                .map(String::from)
                .to_vec(),
            rows: r
                .models
                .iter()
                .map(|m| {
                    vec![
                        m.model.clone(),
                        f3(m.accuracy),
                        f3(m.macro_f1),
                        f3(m.weighted_f1),
                        f3(m.kappa),
                        f3(m.ece),
                        format!("{:.1}", m.latency_p50_ms),
                        m.errors.to_string(),
                        (m.evaluated - m.errors).to_string(),
                    ]
                })
                .collect(),
        });
        d.push(Para(format!(
            "Fleiss' κ across models: {}. Human review: {} of column \"{}\" adjudicated ({} corrected, {} confirmed).",
            r.fleiss_kappa.map(f3).unwrap_or_else(|| "n/a".into()),
            plural(r.reviewed_rows, "row", "rows"),
            task.label_column,
            qc.iter().filter(|c| !c.is_confirmation()).count(),
            qc.iter().filter(|c| c.is_confirmation()).count(),
        )));
        if r.models.len() >= 2 {
            d.push(Heading(4, "Pairwise Cohen's κ between models".into()));
            let mut head = vec![String::new()];
            head.extend(r.models.iter().map(|m| m.model.clone()));
            d.push(Table {
                head,
                rows: r
                    .models
                    .iter()
                    .zip(&r.pairwise_kappa)
                    .map(|(m, row)| std::iter::once(m.model.clone()).chain(row.iter().map(|v| f3(*v))).collect())
                    .collect(),
            });
        }
        for m in &r.models {
            d.push(Heading(4, format!("Confusion matrix — {} (rows: ground truth, columns: predicted)", m.model)));
            let mut head = vec![String::new()];
            head.extend(r.labels.iter().cloned());
            d.push(Table {
                head,
                rows: r
                    .labels
                    .iter()
                    .zip(&m.confusion)
                    .map(|(l, row)| std::iter::once(l.clone()).chain(row.iter().map(|c| c.to_string())).collect())
                    .collect(),
            });
        }
    }

    d.push(Heading(2, "Cost".into()));
    if usage.is_empty() {
        d.push(Para("No usage was logged for this experiment.".into()));
    } else {
        let mut rows: Vec<Vec<String>> = usage
            .iter()
            .map(|u| {
                vec![
                    u.model.clone(),
                    u.requests.to_string(),
                    u.input_tokens.to_string(),
                    u.output_tokens.to_string(),
                    format!("${:.4}", u.cost_usd),
                ]
            })
            .collect();
        rows.push(vec![
            "Total".into(),
            usage.iter().map(|u| u.requests).sum::<u64>().to_string(),
            usage.iter().map(|u| u.input_tokens).sum::<u64>().to_string(),
            usage.iter().map(|u| u.output_tokens).sum::<u64>().to_string(),
            format!("${:.4}", usage.iter().map(|u| u.cost_usd).sum::<f64>()),
        ]);
        d.push(Table {
            head: ["Model", "Requests", "Input tokens", "Output tokens", "Cost (USD)"].map(String::from).to_vec(),
            rows,
        });
    }

    d.push(Heading(2, "Methods".into()));
    d.push(Para(methods(e, dataset_name, reports, corrections)));
    d
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn methods(e: &Experiment, dataset_name: &str, reports: &[Report], corrections: &[LabelCorrection]) -> String {
    let cfg = &e.config;
    let mut s = format!(
        "We classified {} of the dataset \"{dataset_name}\" ({}) using {} ({}). Each model received the {} {} as input and answered all {} in one request per row{}.",
        plural(e.row_indices.len(), "row", "rows"),
        sampling_statement(e),
        plural(cfg.models.len(), "decision model", "decision models"),
        cfg.models.join(", "),
        if cfg.input_columns.len() == 1 { "column" } else { "columns" },
        cfg.input_columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "),
        plural(cfg.tasks.len(), "question", "questions"),
        if cfg.context.as_deref().is_some_and(|c| !c.trim().is_empty()) { ", with a shared context" } else { "" },
    );
    for r in reports {
        let Some(task) = cfg.task(&r.question_id) else { continue };
        let qc = question_corrections(e, task, corrections);
        let changed = qc.iter().filter(|c| !c.is_confirmation()).count();
        s.push_str(&format!(
            " For question \"{}\" ({}), ground truth came from column \"{}\"",
            r.question_id,
            match task.kind {
                TaskKind::Choice => format!("{} labels", task.labels.len()),
                TaskKind::Binary => format!("binary, threshold {:.2}", task.threshold.unwrap_or(0.5)),
            },
            task.label_column
        ));
        if task.labels.iter().any(|l| !l.aliases.is_empty()) {
            s.push_str(" with alternative spellings mapped to their labels");
        }
        s.push_str(&format!(
            "; {} manually adjudicated ({changed} corrected, {} confirmed).",
            if r.reviewed_rows == 1 { "1 row was".to_string() } else { format!("{} rows were", r.reviewed_rows) },
            qc.len() - changed
        ));
        if let Some(best) = r.models.iter().filter(|m| m.evaluated > m.errors).max_by(|a, b| a.macro_f1.total_cmp(&b.macro_f1)) {
            s.push_str(&format!(
                " The best model by macro F1 was {} (macro F1 {:.3}, accuracy {:.3}, Cohen's κ against ground truth {:.3}).",
                best.model, best.macro_f1, best.accuracy, best.kappa
            ));
        }
        if let Some(k) = r.fleiss_kappa {
            s.push_str(&format!(" Agreement between models was κ_Fleiss = {k:.3}."));
        }
    }
    s.push_str(
        " Accuracy, macro- and weighted F1 and Cohen's κ are computed over answered rows only; failed requests are counted as errors. \
         Calibration is the expected calibration error over 10 equal-width bins of the top class probability. Latency is the model's reported evaluation time (local) or the request's wall-clock time (cloud).",
    );
    s
}

// ---- renderers ----------------------------------------------------------------------------

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

fn to_markdown(doc: &[Block]) -> String {
    let mut out = String::new();
    for b in doc {
        match b {
            Block::Heading(l, t) => out.push_str(&format!("{} {t}\n\n", "#".repeat(*l as usize))),
            Block::Para(t) => out.push_str(&format!("{t}\n\n")),
            Block::List(items) => {
                for i in items {
                    out.push_str(&format!("- {}\n", i.replace('\n', " ")));
                }
                out.push('\n');
            }
            Block::Table { head, rows } => {
                out.push_str(&format!("| {} |\n", head.iter().map(|h| md_cell(h)).collect::<Vec<_>>().join(" | ")));
                out.push_str(&format!("|{}|\n", head.iter().map(|_| " --- ").collect::<Vec<_>>().join("|")));
                for r in rows {
                    out.push_str(&format!("| {} |\n", r.iter().map(|c| md_cell(c)).collect::<Vec<_>>().join(" | ")));
                }
                out.push('\n');
            }
        }
    }
    out
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const CSS: &str = "body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f;background:#fff;max-width:980px;margin:40px auto;padding:0 20px}\
h1{font-size:28px;margin-bottom:4px}h2{font-size:21px;margin-top:36px;border-bottom:1px solid #e5e5e7;padding-bottom:6px}h3{font-size:17px;margin-top:26px}h4{font-size:14px;margin:18px 0 6px;color:#555}\
table{border-collapse:collapse;margin:10px 0 18px;font-size:13px;font-variant-numeric:tabular-nums}th,td{border:1px solid #e0e0e3;padding:5px 9px;text-align:left}th{background:#f5f5f7;font-weight:600}\
td.n{text-align:right}ul{padding-left:22px}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}th{background:#2c2c2e}th,td,h2{border-color:#3a3a3c}h4{color:#aaa}}";

fn to_html(title: &str, doc: &[Block]) -> String {
    let mut out = format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{CSS}</style></head><body>\n",
        esc(title)
    );
    for b in doc {
        match b {
            Block::Heading(l, t) => out.push_str(&format!("<h{l}>{}</h{l}>\n", esc(t))),
            Block::Para(t) => out.push_str(&format!("<p>{}</p>\n", esc(t))),
            Block::List(items) => {
                out.push_str("<ul>");
                for i in items {
                    out.push_str(&format!("<li>{}</li>", esc(i)));
                }
                out.push_str("</ul>\n");
            }
            Block::Table { head, rows } => {
                out.push_str("<table><thead><tr>");
                for h in head {
                    out.push_str(&format!("<th>{}</th>", esc(h)));
                }
                out.push_str("</tr></thead><tbody>");
                for r in rows {
                    out.push_str("<tr>");
                    for (i, c) in r.iter().enumerate() {
                        if i == 0 {
                            out.push_str(&format!("<th>{}</th>", esc(c)));
                        } else {
                            let numeric = c.trim_start_matches('$').parse::<f64>().is_ok();
                            out.push_str(&format!("<td{}>{}</td>", if numeric { " class=\"n\"" } else { "" }, esc(c)));
                        }
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</tbody></table>\n");
            }
        }
    }
    out.push_str("</body></html>\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::parse_delimited;
    use crate::store::{ExperimentConfig, Prediction};
    use crate::task::LabelSpec;

    #[test]
    fn report_in_both_formats() {
        let store = Store::open_in_memory().unwrap();
        let d = store
            .insert_dataset("tickets <x>", None, &parse_delimited("text,label\na,x\nb,y\nc,X\n", b',').unwrap())
            .unwrap();
        let task = TaskSpec {
            id: "q".into(),
            kind: TaskKind::Choice,
            instructions: "Which?".into(),
            context: None,
            label_column: "label".into(),
            labels: vec![
                LabelSpec { value: "x".into(), description: Some("the x | one".into()), aliases: vec!["X".into()] },
                LabelSpec { value: "y".into(), description: None, aliases: vec![] },
            ],
            positive_label: None,
            threshold: None,
        };
        let config = ExperimentConfig {
            name: "demo".into(),
            dataset_id: d.id.clone(),
            input_columns: vec!["text".into()],
            context: Some("Shop tickets".into()),
            tasks: vec![task],
            models: vec!["laya".into(), "@openai/gpt-6-luna".into()],
            sample_size: Some(2),
            concurrency: None,
        };
        let id = crate::runner::create(&store, &config).unwrap();
        let e = store.get_experiment(&id).unwrap();
        for m in &config.models {
            for &i in &e.row_indices {
                store
                    .insert_prediction(
                        &id,
                        &Prediction {
                            model: m.clone(),
                            row_idx: i,
                            question_id: "q".into(),
                            ground_truth: "x".into(),
                            predicted: Some("x".into()),
                            confidence: Some(0.8),
                            top_prob: Some(0.9),
                            probabilities: None,
                            latency_ms: Some(12.0),
                            error: None,
                        },
                    )
                    .unwrap();
            }
        }
        store.set_label_correction(&d.id, e.row_indices[0], "label", "y", Some("typo")).unwrap();
        let md = render_report(&store, &id, Format::Markdown).unwrap();
        for needle in [
            "# demo — classification report",
            "Dataset: tickets <x> (3 rows)",
            "seed 0x5EEDC1A5",
            "Shared context: Shop tickets",
            "| x | the x \\| one | X |",
            "| Model | Accuracy | Macro F1 | Weighted F1 | κ |",
            "Fleiss' κ across models",
            "1 row of column \"label\" adjudicated (1 corrected, 0 confirmed)",
            "Confusion matrix — laya",
            "## Methods",
            "using 2 decision models (laya, @openai/gpt-6-luna)",
            "1 row was manually adjudicated",
            "κ_Fleiss",
        ] {
            assert!(md.contains(needle), "missing {needle:?} in\n{md}");
        }
        let html = render_report(&store, &id, Format::Html).unwrap();
        assert!(html.starts_with("<!doctype html>") && html.contains("<style>"));
        assert!(html.contains("tickets &lt;x&gt;") && !html.contains("tickets <x>"));
        assert!(html.contains("<h2>Methods</h2>"));
        assert!(Format::parse("pdf").is_err());
        assert_eq!(Format::parse("HTML").unwrap(), Format::Html);
    }
}
