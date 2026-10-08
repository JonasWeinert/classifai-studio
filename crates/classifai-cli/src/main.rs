//! `classifai` command line (preview). It shares the core crate, the database and the engine with
//! the desktop app; the full command set is planned in docs/PRD.md.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use classifai_core::engine::Engine;
use classifai_core::ollaya::{Answer, Client, DecideRequest, NoulCriteria, Question, DEFAULT_BASE_URL};
use classifai_core::store::Store;
use classifai_core::{eval, runner};
use indexmap::IndexMap;

#[derive(Parser)]
#[command(name = "classifai", version, about = "Classify data with local decision models")]
struct Cli {
    /// Ollaya base URL
    #[arg(long, global = true, env = "OLLAYA_HOST", default_value = DEFAULT_BASE_URL)]
    host: String,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show the engine status
    Status,
    /// List installed models
    Models,
    /// Download a model
    Pull { model: String },
    /// Classify one text: `classifai check "text" -m laya -l billing,technical,account`
    Check {
        text: String,
        /// Model(s) to ask; repeat to compare
        #[arg(short, long = "model", default_value = "laya")]
        models: Vec<String>,
        /// Comma-separated labels (a choice question)
        #[arg(short, long, value_delimiter = ',', conflicts_with = "yes_no")]
        labels: Vec<String>,
        /// A yes/no statement instead of labels
        #[arg(long)]
        yes_no: Option<String>,
        /// Question instructions for --labels
        #[arg(short, long)]
        instructions: Option<String>,
    },
    /// List imported datasets
    Datasets,
    /// List experiments
    Experiments,
    /// Print the leaderboard of an experiment
    Report { id: String },
    /// Run (or resume) an experiment that was created in the app
    Run { id: String },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let client = Client::new(normalize_host(&cli.host));
    let data_dir = classifai_core::default_data_dir();

    match cli.cmd {
        Cmd::Status => {
            let s = Engine::new(&data_dir, client).status().await;
            println!("installed  {}", s.binary_path.as_deref().unwrap_or("no"));
            println!("running    {}", if s.running { "yes" } else { "no" });
            println!("version    {}", s.version.as_deref().unwrap_or("-"));
            println!("url        {}", s.base_url);
        }
        Cmd::Models => {
            for m in client.tags().await? {
                println!("{:<28} {:>8} {:>10}", m.name, m.details.parameter_size, human_size(m.size));
            }
        }
        Cmd::Pull { model } => {
            let mut on_progress_line = false;
            client
                .pull(&model, |p| match (p.completed, p.total) {
                    (Some(c), Some(t)) if t > 0 => {
                        eprint!("\r{:<32} {:>5.1}%", p.status, 100.0 * c as f64 / t as f64);
                        on_progress_line = true;
                    }
                    _ => {
                        if std::mem::take(&mut on_progress_line) {
                            eprintln!();
                        }
                        eprintln!("{}", p.status);
                    }
                })
                .await?;
        }
        Cmd::Check { text, models, labels, yes_no, instructions } => {
            let question = match (labels.is_empty(), yes_no) {
                (_, Some(stmt)) => Question::Noul { instructions: Some(stmt), criteria: Some(NoulCriteria::default()) },
                (false, None) => Question::Choice {
                    instructions,
                    criteria: labels.into_iter().map(|l| (l.trim().to_string(), None)).collect(),
                },
                (true, None) => bail!("pass --labels a,b,c or --yes-no \"statement\""),
            };
            let mut questions = IndexMap::new();
            questions.insert("answer".to_string(), question);
            for model in models {
                let req = DecideRequest {
                    model: model.clone(),
                    state: Some(text.clone().into()),
                    questions: Some(questions.clone()),
                    ..Default::default()
                };
                match client.decide(&req).await {
                    Ok(r) => {
                        let ms = r.eval_duration as f64 / 1e6;
                        match &r.answers["answer"] {
                            Answer::Choice { choice, confidence, .. } => {
                                println!("{:<24} {choice:<20} conf {confidence:.2}  {ms:.0} ms", r.model)
                            }
                            Answer::Noul { noul } => println!("{:<24} p(yes) {noul:.3}  {ms:.0} ms", r.model),
                            Answer::Score { score, .. } => println!("{:<24} score {score:.2}  {ms:.0} ms", r.model),
                        }
                    }
                    Err(e) => println!("{model:<24} error: {e}"),
                }
            }
        }
        Cmd::Datasets => {
            let store = Store::open(&data_dir.join(classifai_core::DB_FILE))?;
            for d in store.list_datasets()? {
                println!("{}  {:<32} {:>7} rows  {}", d.id, d.name, d.row_count, d.columns.join(", "));
            }
        }
        Cmd::Experiments => {
            let store = Store::open(&data_dir.join(classifai_core::DB_FILE))?;
            for e in store.list_experiments(None)? {
                println!("{}  {:<28} {:?}  {}", e.id, e.name, e.status, e.config.models.join(", "));
            }
        }
        Cmd::Report { id } => {
            let store = Store::open(&data_dir.join(classifai_core::DB_FILE))?;
            let e = store.get_experiment(&id)?;
            let r = eval::report(&e.config.task.label_values(), &e.config.models, &store.predictions(&id)?);
            println!("{:<28} {:>8} {:>8} {:>8} {:>9} {:>6}", "model", "acc", "macroF1", "ECE", "p50 ms", "errors");
            for m in r.models {
                println!(
                    "{:<28} {:>8.3} {:>8.3} {:>8.3} {:>9.1} {:>6}",
                    m.model, m.accuracy, m.macro_f1, m.ece, m.latency_p50_ms, m.errors
                );
            }
        }
        Cmd::Run { id } => {
            let store = Arc::new(Store::open(&data_dir.join(classifai_core::DB_FILE))?);
            let status = runner::execute(store, client, id, Arc::new(AtomicBool::new(false)), |ev| {
                if let Some(m) = &ev.model {
                    eprint!("\r{m:<28} {}/{}", ev.done, ev.total);
                }
            })
            .await?;
            eprintln!("\n{status:?}");
        }
    }
    Ok(())
}

/// Same rules as Ollaya's `OLLAYA_HOST`: empty means the default, a missing scheme means http.
fn normalize_host(h: &str) -> String {
    let h = h.trim();
    if h.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else {
        format!("http://{h}")
    }
}

fn human_size(b: u64) -> String {
    let gb = b as f64 / 1e9;
    if gb >= 1.0 { format!("{gb:.1} GB") } else { format!("{:.0} MB", b as f64 / 1e6) }
}
