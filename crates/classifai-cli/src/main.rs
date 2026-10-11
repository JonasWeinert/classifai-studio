//! `classifai` command line (preview). It shares the core crate, the database and the engine with
//! the desktop app; the full command set is planned in docs/PRD.md.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use classifai_core::decider::{Decider, UsageContext};
use classifai_core::engine::Engine;
use classifai_core::ollaya::{Answer, Client, NoulCriteria, Question, DEFAULT_BASE_URL};
use classifai_core::secrets::KeychainSecrets;
use classifai_core::store::Store;
use classifai_core::{analysis, export, runner};
use indexmap::IndexMap;

#[derive(Parser)]
#[command(name = "classifai", version, about = "ClassifAI Studio on the command line: classify text and read evaluations")]
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
    /// List installed models and enabled cloud models
    Models,
    /// Download a model
    Pull { model: String },
    /// Classify one text: `classifai check "text" -m laya -l billing,technical,account`
    Check {
        text: String,
        /// Model(s) to ask; repeat to compare. Cloud models: @provider/model, e.g. @typesafe/jev-latest
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
    /// Print the leaderboard of an experiment, one per question
    Report { id: String },
    /// Write a report of an experiment (setup, metrics, agreement, cost, methods) to a file
    Export {
        id: String,
        path: String,
        /// md or html; default from the file extension, else md
        #[arg(long)]
        format: Option<String>,
    },
    /// Run (or resume) an experiment that was created in the app
    Run { id: String },
    /// Requests, tokens and cost per model
    Usage {
        /// Only usage at or after this RFC 3339 time, e.g. 2026-10-01
        #[arg(long)]
        since: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let client = Client::new(normalize_host(&cli.host));
    let data_dir = classifai_core::default_data_dir();
    let open_store = || -> Result<Arc<Store>> { Ok(Arc::new(Store::open(&data_dir.join(classifai_core::DB_FILE))?)) };
    let decider = |client: Client, store: Arc<Store>| Arc::new(Decider::new(client, store, Arc::new(KeychainSecrets)));

    match cli.cmd {
        Cmd::Status => {
            let s = Engine::new(&data_dir, client).status().await;
            println!("installed  {}", s.binary_path.as_deref().unwrap_or("no"));
            println!("running    {}", if s.running { "yes" } else { "no" });
            println!("version    {}", s.version.as_deref().unwrap_or("-"));
            println!("url        {}", s.base_url);
        }
        Cmd::Models => {
            match client.tags().await {
                Ok(models) => {
                    for m in models {
                        println!("{:<28} {:>8} {:>10}", m.name, m.details.parameter_size, human_size(m.size));
                    }
                }
                Err(e) => eprintln!("local models unavailable: {e}"),
            }
            let store = open_store()?;
            for p in store.list_providers()? {
                for m in store.list_cloud_models(Some(&p.id))?.into_iter().filter(|m| m.enabled) {
                    let key = if p.has_key || !p.kind.requires_key() { "" } else { "  (no API key)" };
                    println!(
                        "{:<28} {:>8} ${:.3}/M in, ${:.3}/M out{key}",
                        m.id(),
                        "cloud",
                        m.input_price_per_mtok,
                        m.output_price_per_mtok
                    );
                }
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
            let decider = decider(client, open_store()?);
            for model in models {
                match decider.decide(&model, text.clone().into(), questions.clone(), &UsageContext::quick()).await {
                    Ok(r) => {
                        let ms = r.latency_ms;
                        let cost = if r.cost_usd > 0.0 { format!("  ${:.6}", r.cost_usd) } else { String::new() };
                        match r.answers.get("answer") {
                            Some(Answer::Choice { choice, confidence, .. }) => {
                                println!("{model:<24} {choice:<20} conf {confidence:.2}  {ms:.0} ms{cost}")
                            }
                            Some(Answer::Noul { noul }) => println!("{model:<24} p(yes) {noul:.3}  {ms:.0} ms{cost}"),
                            Some(Answer::Score { score, .. }) => println!("{model:<24} score {score:.2}  {ms:.0} ms{cost}"),
                            Some(Answer::Text { text }) => println!("{model:<24} {text}  {ms:.0} ms{cost}"),
                            None if !r.refused.is_empty() => println!("{model:<24} refused to answer"),
                            None => println!("{model:<24} error: answer missing from response"),
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
            for (i, r) in analysis::reports(&store, &e)?.into_iter().enumerate() {
                if i > 0 {
                    println!();
                }
                println!("== {} ==", r.question_id);
                println!(
                    "{:<28} {:>8} {:>8} {:>8} {:>8} {:>9} {:>6}",
                    "model", "acc", "macroF1", "kappa", "ECE", "p50 ms", "errors"
                );
                for m in &r.models {
                    println!(
                        "{:<28} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>9.1} {:>6}",
                        m.model, m.accuracy, m.macro_f1, m.kappa, m.ece, m.latency_p50_ms, m.errors
                    );
                }
                if let Some(k) = r.fleiss_kappa {
                    println!("Fleiss kappa {k:.3}");
                }
                if r.reviewed_rows > 0 {
                    println!("{} rows reviewed by a human", r.reviewed_rows);
                }
            }
        }
        Cmd::Export { id, path, format } => {
            let store = Store::open(&data_dir.join(classifai_core::DB_FILE))?;
            let format = match format {
                Some(f) => export::Format::parse(&f)?,
                None if path.to_ascii_lowercase().ends_with(".html") || path.to_ascii_lowercase().ends_with(".htm") => {
                    export::Format::Html
                }
                None => export::Format::Markdown,
            };
            let written = export::write_report(&store, &id, &path, format)?;
            println!("{written}");
        }
        Cmd::Run { id } => {
            let store = open_store()?;
            let status = runner::execute(store.clone(), decider(client, store), id, Arc::new(AtomicBool::new(false)), |ev| {
                if let Some(m) = &ev.model {
                    eprint!("\r{m:<28} {}/{}", ev.done, ev.total);
                }
            })
            .await?;
            eprintln!("\n{status:?}");
        }
        Cmd::Usage { since } => {
            let rows = open_store()?.usage_summary(since.as_deref())?;
            println!("{:<32} {:>9} {:>14} {:>14} {:>12}", "model", "requests", "input tokens", "output tokens", "cost USD");
            for r in &rows {
                println!(
                    "{:<32} {:>9} {:>14} {:>14} {:>12.6}",
                    r.model, r.requests, r.input_tokens, r.output_tokens, r.cost_usd
                );
            }
            let total: f64 = rows.iter().map(|r| r.cost_usd).sum();
            println!("{:<32} {:>9} {:>14} {:>14} {:>12.6}", "total", "", "", "", total);
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
