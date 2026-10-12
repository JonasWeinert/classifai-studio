//! End-to-end check of fine-tuning, as the app runs it: install the trainer (unless it is there),
//! import a labelled CSV, set up an evaluation over it, fine-tune, and test the result on the
//! held-out rows against the base model in Ollaya. Uses its own data folder, not the app's.
//!
//!     cargo run -p classifai-core --example finetune_e2e -- --data-dir /tmp/ft-e2e \
//!         --csv rows.csv --questions questions.json --label-column section --base laya-en
//!
//! `--questions` takes Unsloth's decision format, choice questions only (as `decision_eval`).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use classifai_core::dataset::parse_delimited;
use classifai_core::decider::{Decider, UsageContext};
use classifai_core::finetune::{self, FineTuneInput, Manager, Settings, Status};
use classifai_core::ollaya::{Client, Question};
use classifai_core::secrets::MemorySecrets;
use classifai_core::store::{ExperimentConfig, Store};
use classifai_core::task::{LabelSpec, TaskKind, TaskSpec};
use classifai_core::analysis;
use indexmap::IndexMap;
use serde_json::Value;

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() -> Result<()> {
    let data_dir = std::path::PathBuf::from(flag("--data-dir").context("--data-dir")?);
    let csv = flag("--csv").context("--csv")?;
    let questions: Value = serde_json::from_str(&std::fs::read_to_string(flag("--questions").context("--questions")?)?)?;
    let label_column = flag("--label-column").context("--label-column")?;
    let base = flag("--base").unwrap_or_else(|| "laya-en".into());
    let epochs: f64 = flag("--epochs").map(|e| e.parse()).transpose()?.unwrap_or(1.0);
    std::fs::create_dir_all(&data_dir)?;

    let store = Arc::new(Store::open(&data_dir.join("classifai.db"))?);
    let decider = Arc::new(Decider::new(Client::new("http://127.0.0.1:11435"), store.clone(), Arc::new(MemorySecrets::new())));
    let manager = Manager::new(&data_dir, store.clone(), decider.clone());

    let status = manager.trainer.status();
    println!("trainer: supported={} installed={} memory={:.0} GB free={:.0} GB", status.supported, status.installed, status.memory_gb, status.disk_free_gb);
    if !status.installed {
        let started = std::time::Instant::now();
        manager.trainer.install(&|line: String| println!("  | {line}")).await?;
        println!("installed in {:.0} s, {:.2} GB", started.elapsed().as_secs_f64(), manager.trainer.status().size_bytes as f64 / 1e9);
    }

    // An evaluation over the CSV, as the app would have one.
    let data = parse_delimited(&std::fs::read_to_string(&csv)?, b',')?;
    let dataset = store.insert_dataset("e2e rows", Some(&csv), &data)?;
    let tasks: Vec<TaskSpec> = questions
        .as_object()
        .context("questions")?
        .iter()
        .map(|(id, q)| TaskSpec {
            id: id.clone(),
            kind: TaskKind::Choice,
            instructions: q["instructions"].as_str().unwrap_or_default().into(),
            context: None,
            label_column: label_column.clone(),
            labels: q["criteria"]
                .as_object()
                .map(|c| c.iter().map(|(v, d)| LabelSpec { value: v.clone(), description: d.as_str().map(Into::into), aliases: vec![] }).collect())
                .unwrap_or_default(),
            positive_label: None,
            threshold: None,
            when: None,
        })
        .collect();
    let config = ExperimentConfig {
        name: "e2e setup".into(),
        dataset_id: dataset.id.clone(),
        input_columns: vec!["text".into()],
        context: None,
        tasks,
        models: vec!["laya:en".into(), "laya:multilingual".into()],
        sample_size: None,
        concurrency: Some(4),
    };
    let preview = finetune::preview(&store, &config, 0.2, Some(&base))?;
    println!("preview: {:?}\n  errors {:?}\n  warnings {:?}\n  compare with {:?}", preview.split, preview.errors, preview.warnings, preview.compare_with);
    if !preview.errors.is_empty() {
        bail!("preview has errors");
    }

    let b = finetune::base(&base)?;
    let f = manager.create(
        FineTuneInput {
            name: format!("e2e {base}"),
            base: base.clone(),
            config,
            source_experiment_id: None,
            settings: Settings { epochs, learning_rate: b.learning_rate, lora_rank: 16, holdout: 0.2, max_length: b.max_length, seed: 7 },
        },
        Arc::new(|f| {
            let p = &f.progress;
            eprintln!("  {:?} {} step {}/{} loss {:?}", f.status, p.stage.as_deref().unwrap_or("-"), p.step, p.total_steps, p.loss.last().map(|l| l.1));
        }),
    )?;
    println!("started {} as {}", f.id, f.model);
    let started = std::time::Instant::now();
    let f = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let f = store.get_finetune(&f.id)?;
        if !f.status.is_active() {
            break f;
        }
    };
    println!("finished {:?} in {:.0} s; error {:?}", f.status, started.elapsed().as_secs_f64(), f.error);
    println!("calibration rows: before {:?} after {:?}; split {:?}; {} bytes", f.before, f.after, f.split, f.size_bytes);
    let analysis = manager.analysis(&f.id)?;
    let learned = analysis.rows.iter().filter(|r| r.before.as_ref() != Some(&r.gold) && r.after.as_ref() == Some(&r.gold)).count();
    println!(
        "weights {:?} trainable {:?}; analysis: {} rows, {} learned; batch {} records {}",
        f.parameters, f.trainable_parameters, analysis.rows.len(), learned, f.progress.batch_size, f.progress.records
    );
    if f.status != Status::Ready {
        println!("--- trainer log ---\n{}", manager.log_tail(&f.id, 40));
        bail!("fine-tune did not finish");
    }

    let e = store.get_experiment(f.eval_experiment_id.as_deref().context("no held-out evaluation")?)?;
    for task in &e.config.tasks {
        let report = analysis::report(&store, &e, task)?;
        println!("\nheld-out {} ({} rows)", task.id, e.row_indices.len());
        for m in &report.models {
            println!("  {:<40} accuracy {:.3}  macro F1 {:.3}  ECE {:.3}  errors {}  p50 {:.0} ms", m.model, m.accuracy, m.macro_f1, m.ece, m.errors, m.latency_p50_ms);
        }
    }

    // The model answers like any other through the decider.
    let mut q = IndexMap::new();
    q.insert(
        "section".to_string(),
        serde_json::from_value::<Question>(questions["section"].clone()).context("section question")?,
    );
    let d = decider.decide(&f.model, Value::String("Patients were randomly assigned to drug A or placebo.".into()), q, &UsageContext::quick()).await?;
    println!("\n{} says {:?} in {:.0} ms", f.model, d.answers["section"], d.latency_ms);
    println!("models listed: {:?}", manager.local_models().iter().map(|m| &m.name).collect::<Vec<_>>());
    manager.server.restart().await;
    Ok(())
}
