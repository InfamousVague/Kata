//! Kata Tauri backend.
//!
//! Exposes the narrow native API the frontend needs:
//!   - `run_swift` — writes user code to a temp file and execs the system
//!     `swift` toolchain against it. Fallback for a language we can't run
//!     in-browser.
//!   - `progress_db` — SQLite-backed lesson-completion store.
//!   - (future) `run_cargo_local`, `course_fs`.

mod courses;
mod progress_db;

use std::io::Write;
use std::process::Command;
use std::time::Instant;

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Serialize)]
pub struct SubprocessResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub duration_ms: u64,
    /// Set when we couldn't even start the process (e.g. swift not installed).
    pub launch_error: Option<String>,
}

/// Runs the user's Swift source by writing it to a temp file and invoking the
/// system `swift` interpreter in script mode. Frontend parses stdout/stderr.
/// Returns `launch_error` rather than a Result-Err so the frontend can
/// distinguish "swift isn't installed" from a timeout or Rust-side panic.
#[tauri::command]
async fn run_swift(code: String) -> SubprocessResult {
    let start = Instant::now();

    let temp_path = std::env::temp_dir().join("kata-swift-run.swift");
    if let Err(e) = std::fs::File::create(&temp_path).and_then(|mut f| f.write_all(code.as_bytes())) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to write temp source: {e}")),
        };
    }

    let output = match Command::new("swift").arg(&temp_path).output() {
        Ok(o) => o,
        Err(e) => {
            let hint = if e.kind() == std::io::ErrorKind::NotFound {
                "swift toolchain not found on PATH — install Xcode Command Line Tools: `xcode-select --install`".to_string()
            } else {
                format!("failed to launch swift: {e}")
            };
            return SubprocessResult {
                stdout: String::new(),
                stderr: String::new(),
                success: false,
                duration_ms: start.elapsed().as_millis() as u64,
                launch_error: Some(hint),
            };
        }
    };

    SubprocessResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        success: output.status.success(),
        duration_ms: start.elapsed().as_millis() as u64,
        launch_error: None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db_path = progress_db::resolve_path(app.handle())?;
            let db = progress_db::open(db_path)?;
            app.manage(db);
            courses::ensure_seed(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_swift,
            progress_db::list_completions,
            progress_db::mark_completion,
            progress_db::clear_completions,
            courses::list_courses,
            courses::load_course,
            courses::save_course,
            courses::delete_course,
            courses::export_course,
            courses::import_course,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
