//! Evaluate decision models on a labelled CSV through the regular experiment runner: Ollaya
//! models by name, and any `/v1/systemone` server (such as llama.cpp serving a fine-tuned GGUF)
//! as a custom provider. The experiment lands in the app's database, so it can be opened there.
//!
//!     cargo run -p classifai-core --example decision_eval -- \
//!         --csv test.csv --questions questions.json --label-column section \
//!         --model laya:en --endpoint "Laya PubMed=http://127.0.0.1:9931#laya-pubmed"
//!
//! `--questions` takes Unsloth's decision format ({id: {type: "choice", instructions, criteria}});
//! choice questions only. `--db memory` keeps everything out of the app's database.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use classifai_core::dataset::parse_delimited;
use classifai_core::decider::Decider;
use classifai_core::ollaya::Client;
use classifai_core::providers::{CloudModelInput, ProviderInput, ProviderKind};
use classifai_core::secrets::KeychainSecrets;
use classifai_core::store::{ExperimentConfig, ExperimentStatus, Store};
use classifai_core::task::{LabelSpec, TaskKind, TaskSpec};
use classifai_core::{eval, runner};
use serde_json::Value;

struct Args {
    csv: String,
    questions: String,
    label_column: String,
    input_column: String,
    models: Vec<String>,
    endpoints: Vec<(String, String, String)>,
    db: String,
    name: String,
    ollaya: String,
}

fn args() -> Result<Args> {
    let mut a = Args {
        csv: String::new(),
        questions: String::new(),
        label_column: String::new(),
        input_column: "text".into(),
        models: vec![],
        endpoints: vec![],
        db: "app".into(),
        name: "decision eval".into(),
        ollaya: "http://127.0.0.1:11435".into(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().with_context(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--csv" => a.csv = value()?,
            "--questions" => a.questions = value()?,
            "--label-column" => a.label_column = value()?,
            "--input-column" => a.input_column = value()?,
            "--model" => a.models.push(value()?),
            "--endpoint" => {
                // "Name=http://host:port#model"
                let v = value()?;
                let (name, rest) = v.split_once('=').context("--endpoint is Name=url#model")?;
                let (url, model) = rest.split_once('#').context("--endpoint is Name=url#model")?;
                a.endpoints.push((name.into(), url.into(), model.into()));
            }
            "--db" => a.db = value()?,
            "--name" => a.name = value()?,
            "--ollaya" => a.ollaya = value()?,
            _ => bail!("unknown flag {flag}"),
        }
    }
    if a.csv.is_empty() || a.questions.is_empty() || a.label_column.is_empty() {
        bail!("--csv, --questions and --label-column are required");
    }
    Ok(a)
}

fn tasks(questions: &Value, label_column: &str) -> Result<Vec<TaskSpec>> {
    let questions = questions.as_object().context("questions must be an object")?;
    questions
        .iter()
        .map(|(id, q)| {
            if q["type"] != "choice" {
                bail!("{id}: only choice questions are supported");
            }
            let criteria = q["criteria"].as_object().with_context(|| format!("{id}: criteria"))?;
            Ok(TaskSpec {
                id: id.clone(),
                kind: TaskKind::Choice,
                instructions: q["instructions"].as_str().unwrap_or_default().into(),
                context: None,
                label_column: label_column.into(),
                labels: criteria
                    .iter()
                    .map(|(value, d)| LabelSpec { value: value.clone(), description: d.as_str().map(Into::into), aliases: vec![] })
                    .collect(),
                positive_label: None,
                threshold: None,
                when: None,
            })
        })
        .collect()
}

#[tokio::main]
async fn main() -> Result<()> {
    let a = args()?;
    let store = Arc::new(match a.db.as_str() {
        "memory" => Store::open_in_memory()?,
        "app" => Store::open(&classifai_core::default_data_dir().join(classifai_core::DB_FILE))?,
        path => Store::open(std::path::Path::new(path))?,
    });
    let decider = Arc::new(Decider::new(Client::new(&a.ollaya), store.clone(), Arc::new(KeychainSecrets)));

    let mut models = a.models.clone();
    for (name, url, model) in &a.endpoints {
        let existing = store.list_providers()?.into_iter().find(|p| p.name == *name && p.kind == ProviderKind::Custom);
        let provider = decider.save_provider(ProviderInput {
            id: existing.map(|p| p.id),
            kind: ProviderKind::Custom,
            name: name.clone(),
            base_url: Some(url.clone()),
            account_id: None,
            api_key: None,
        })?;
        let id = provider.provider.id;
        decider.save_cloud_model(CloudModelInput {
            provider_id: id.clone(),
            model: model.clone(),
            display_name: Some(name.clone()),
            input_price_per_mtok: 0.0,
            output_price_per_mtok: 0.0,
            enabled: true,
        })?;
        models.push(format!("@{id}/{model}"));
    }
    if models.is_empty() {
        bail!("pass at least one --model or --endpoint");
    }

    let csv = std::fs::read_to_string(&a.csv).with_context(|| a.csv.clone())?;
    let stem = std::path::Path::new(&a.csv).file_stem().and_then(|s| s.to_str()).unwrap_or("dataset");
    let dataset = store.insert_dataset(stem, Some(&a.csv), &parse_delimited(&csv, b',')?)?;
    let questions: Value = serde_json::from_str(&std::fs::read_to_string(&a.questions)?)?;
    let config = ExperimentConfig {
        name: a.name.clone(),
        dataset_id: dataset.id,
        input_columns: vec![a.input_column.clone()],
        context: None,
        tasks: tasks(&questions, &a.label_column)?,
        models: models.clone(),
        sample_size: None,
        concurrency: Some(4),
    };
    let id = runner::create(&store, &config)?;
    eprintln!("experiment {id}: {} rows × {} models", dataset.row_count, models.len());
    let status = runner::execute(store.clone(), decider, id.clone(), Arc::new(AtomicBool::new(false)), |_| {}).await?;
    if status != ExperimentStatus::Completed {
        bail!("experiment ended {status:?}");
    }

    for task in &config.tasks {
        let report = eval::report(&task.id, &task.label_values(), &models, &store.predictions_for(&id, &task.id)?);
        println!("\n{} ({} rows)", task.id, dataset.row_count);
        println!("{:<34} {:>8} {:>8} {:>8} {:>8} {:>7} {:>9}", "model", "accuracy", "macro F1", "kappa", "ECE", "errors", "p50 ms");
        for m in &report.models {
            println!(
                "{:<34} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>7} {:>9.0}",
                m.model, m.accuracy, m.macro_f1, m.kappa, m.ece, m.errors, m.latency_p50_ms
            );
        }
    }
    println!("\nexperiment id: {id}");
    Ok(())
}
