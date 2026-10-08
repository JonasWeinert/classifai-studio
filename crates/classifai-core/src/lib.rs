//! ClassifAI core: everything the desktop app and the CLI share.
//!
//! - [`ollaya`]: typed HTTP client for the Ollaya daemon (`/api/decide`, `/api/pull`, ...)
//! - [`engine`]: locate, install, start and stop the Ollaya binary
//! - [`dataset`]: parse CSV / TSV / JSON / JSONL files into rows
//! - [`store`]: SQLite persistence for datasets, experiments and predictions
//! - [`questions`]: pick-any, rank and number questions built from Ollaya's primitives
//! - [`task`]: turn a dataset row + ground-truth mapping into an Ollaya question
//! - [`runner`]: execute an experiment (rows x models) with progress and cancellation
//! - [`eval`]: accuracy, F1, confusion matrices, calibration, latency
//! - [`catalog`]: curated list of decision models offered in the UI
//! - [`providers`]: cloud providers (TypeSafe, OpenAI, Cloudflare, custom), model ids and prices
//! - [`cloud`]: HTTP clients for cloud decision models, translated to Ollaya's types
//! - [`secrets`]: provider API keys in the OS keychain
//! - [`decider`]: one entry point for local and cloud decisions, with usage and cost logging

pub mod catalog;
pub mod cloud;
pub mod dataset;
pub mod decider;
pub mod engine;
pub mod error;
pub mod eval;
pub mod ollaya;
pub mod providers;
pub mod questions;
pub mod runner;
pub mod secrets;
pub mod store;
pub mod task;

pub use error::{Error, Result};

/// Bundle identifier; the app data directory is `<platform data dir>/<APP_ID>`, as Tauri's
/// `app_data_dir()` resolves it, so the desktop app and the CLI share one database and engine.
pub const APP_ID: &str = "dev.classifai.app";

pub fn default_data_dir() -> std::path::PathBuf {
    dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join(APP_ID)
}

pub const DB_FILE: &str = "classifai.db";

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
