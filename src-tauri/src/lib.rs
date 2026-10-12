mod cli_install;
mod commands;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use classifai_core::decider::Decider;
use classifai_core::engine::Engine;
use classifai_core::finetune;
use classifai_core::ollaya::Client;
use classifai_core::secrets::KeychainSecrets;
use classifai_core::store::Store;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub struct AppState {
    pub store: Arc<Store>,
    pub engine: Arc<Engine>,
    /// Local and cloud decisions, providers and API keys (OS keychain).
    pub decider: Arc<Decider>,
    /// experiment id -> cancel flag of the running task
    pub running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Cancel flag of the Hugging Face import in progress.
    pub hf_cancel: Arc<AtomicBool>,
    /// Fine-tunes, the trainer environment and the server for fine-tuned models.
    pub finetunes: Arc<finetune::Manager>,
    /// The trainer is being installed (only one install at a time).
    pub trainer_installing: Arc<AtomicBool>,
}

impl AppState {
    pub fn client(&self) -> Client {
        self.engine.client().clone()
    }
}

/// Custom menu items: (id = payload of `menu://action`, title, accelerator).
const MENU_ACTIONS: &[(&str, &str, &str)] = &[
    ("about", "About ClassifAI Studio", ""),
    ("licenses", "Open Source Licenses", ""),
    ("settings", "Settings…", "CmdOrCtrl+,"),
    ("import", "Import Dataset…", "CmdOrCtrl+O"),
    ("new-experiment", "New Evaluation", "CmdOrCtrl+N"),
    ("nav:quick", "Playground", "CmdOrCtrl+1"),
    ("nav:bulk", "Bulk", "CmdOrCtrl+2"),
    ("nav:experiments", "Evaluations", "CmdOrCtrl+3"),
    ("nav:labelling", "Manual Labelling", "CmdOrCtrl+4"),
    ("nav:question-sets", "Question Sets", "CmdOrCtrl+5"),
    ("nav:datasets", "Datasets", "CmdOrCtrl+6"),
    ("nav:models", "Models", "CmdOrCtrl+7"),
    ("palette", "Command Palette", "CmdOrCtrl+K"),
    ("back", "Back", "CmdOrCtrl+["),
    ("toggle-sidebar", "Toggle Sidebar", "Ctrl+CmdOrCtrl+S"),
];

/// The native menu bar. Custom items emit `menu://action` with their id; the standard Edit items
/// are what make copy/paste/undo work in text fields on macOS.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str| -> tauri::Result<_> {
        let (id, title, accel) = MENU_ACTIONS.iter().find(|(i, ..)| *i == id).expect("menu action");
        let b = MenuItemBuilder::with_id(*id, *title);
        if accel.is_empty() { b.build(app) } else { b.accelerator(*accel).build(app) }
    };
    // "About" opens the app's own About page (with a clickable repository link) instead of the
    // standard panel.
    let app_menu = SubmenuBuilder::new(app, "ClassifAI Studio")
        .item(&item("about")?)
        .item(&item("licenses")?)
        .separator()
        .item(&item("settings")?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("import")?)
        .item(&item("new-experiment")?)
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle-sidebar")?)
        .separator()
        .item(&item("nav:quick")?)
        .item(&item("nav:bulk")?)
        .item(&item("nav:experiments")?)
        .separator()
        .item(&item("nav:labelling")?)
        .separator()
        .item(&item("nav:question-sets")?)
        .item(&item("nav:datasets")?)
        .separator()
        .item(&item("nav:models")?)
        .separator()
        .item(&item("palette")?)
        .separator()
        .fullscreen()
        .build()?;
    let go = SubmenuBuilder::new(app, "Go").item(&item("back")?).build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().bring_all_to_front().build()?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if MENU_ACTIONS.iter().any(|(a, ..)| *a == id) {
                    let _ = app.emit("menu://action", id);
                }
            });
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = Store::open(&data_dir.join(classifai_core::DB_FILE))?;
            let host = std::env::var("OLLAYA_HOST").ok();
            let client = Client::new(match host.as_deref() {
                Some(h) if h.starts_with("http") => h.to_string(),
                Some(h) if !h.is_empty() => format!("http://{h}"),
                _ => classifai_core::ollaya::DEFAULT_BASE_URL.to_string(),
            });
            let store = Arc::new(store);
            let decider = Arc::new(Decider::new(client.clone(), store.clone(), Arc::new(KeychainSecrets)));
            let engine = Engine::new(&data_dir, client);
            let finetunes = finetune::Manager::new(&data_dir, store.clone(), decider.clone());
            app.manage(AppState {
                store,
                engine: Arc::new(engine),
                decider,
                running: Mutex::new(HashMap::new()),
                hf_cancel: Arc::new(AtomicBool::new(false)),
                finetunes,
                trainer_installing: Arc::new(AtomicBool::new(false)),
            });

            // Start the engine in the background if it is installed but not running.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                if state.engine.find_binary().is_some() {
                    let _ = state.engine.start().await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::engine_status,
            commands::engine_install,
            commands::engine_start,
            commands::engine_stop,
            commands::models_installed,
            commands::models_catalog,
            commands::model_pull,
            commands::model_delete,
            commands::presets_list,
            commands::preset_show,
            commands::save_text_file,
            commands::read_text_file,
            commands::quick_classify,
            commands::dataset_import,
            commands::dataset_list,
            commands::dataset_get,
            commands::dataset_rows,
            commands::dataset_import_text,
            commands::dataset_value_counts,
            commands::dataset_column_profile,
            commands::dataset_create,
            commands::dataset_derive,
            commands::ui_state_get,
            commands::models_loaded,
            commands::spreadsheet_inspect,
            commands::spreadsheet_import,
            commands::files_import,
            commands::hf_info,
            commands::label_session_create,
            commands::label_sessions_list,
            commands::label_session_get,
            commands::label_answer_set,
            commands::label_mark_set,
            commands::label_evidence_set,
            commands::label_position_set,
            commands::label_session_update,
            commands::label_session_set_saved,
            commands::label_session_delete,
            commands::dataset_rows_at,
            commands::hf_import,
            commands::hf_cancel,
            commands::hf_token_status,
            commands::hf_token_set,
            commands::bulk_run_create,
            commands::bulk_results_put,
            commands::bulk_run_finish,
            commands::bulk_runs_list,
            commands::bulk_run_get,
            commands::bulk_run_rename,
            commands::bulk_run_set_saved,
            commands::bulk_run_delete,
            commands::ui_state_set,
            commands::experiment_save_as_dataset,
            commands::dataset_rename,
            commands::dataset_delete,
            commands::experiment_create,
            commands::experiment_start,
            commands::experiment_cancel,
            commands::experiment_list,
            commands::experiment_get,
            commands::experiment_report,
            commands::experiment_predictions,
            commands::experiment_delete,
            commands::experiment_export_csv,
            commands::experiment_usage,
            commands::experiment_estimate,
            commands::experiment_threshold_curve,
            commands::experiment_set_threshold,
            commands::experiment_review_queue,
            commands::experiment_export_report,
            commands::label_correction_set,
            commands::label_correction_clear,
            commands::label_corrections_list,
            commands::question_sets_list,
            commands::question_set_get,
            commands::question_set_save,
            commands::question_set_delete,
            commands::settings_get,
            commands::settings_save,
            commands::budget_status,
            commands::models_track_record,
            commands::providers_list,
            commands::provider_save,
            commands::provider_delete,
            commands::provider_test,
            commands::provider_models,
            commands::cli_status,
            commands::cli_install,
            commands::cli_uninstall,
            commands::cloud_model_save,
            commands::cloud_model_delete,
            commands::usage_summary,
            commands::finetune_bases,
            commands::trainer_status,
            commands::trainer_install,
            commands::trainer_uninstall,
            commands::finetune_list,
            commands::finetune_get,
            commands::finetune_preview,
            commands::finetune_create,
            commands::finetune_cancel,
            commands::finetune_delete,
            commands::finetune_log,
            commands::finetune_folder,
            commands::finetune_analysis,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                let engine = state.engine.clone();
                let server = state.finetunes.server.clone();
                tauri::async_runtime::block_on(async move {
                    server.restart().await;
                    let _ = engine.stop().await;
                });
            }
        });
}
