//! Tiny SQLite-backed progress store.
//!
//! Schema is intentionally small for V1 — one row per (course, lesson) the
//! user has completed. A future iteration can add per-run logs (for streaks,
//! time-on-task, test attempts) without migration pain because we version
//! the schema here.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{Manager, State};

pub struct ProgressDb(pub Mutex<Connection>);

#[derive(Debug, Serialize)]
pub struct Completion {
    pub course_id: String,
    pub lesson_id: String,
    pub completed_at: i64,
}

pub fn open(db_path: PathBuf) -> anyhow::Result<ProgressDb> {
    let conn = Connection::open(&db_path)?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS completions (
            course_id TEXT NOT NULL,
            lesson_id TEXT NOT NULL,
            completed_at INTEGER NOT NULL,
            PRIMARY KEY (course_id, lesson_id)
        );
        "#,
    )?;
    Ok(ProgressDb(Mutex::new(conn)))
}

/// Build the path where the SQLite file lives. Uses Tauri's resolved app-data
/// dir so it ends up in the platform-appropriate location (~/Library/Application
/// Support/com.mattssoftware.kata on macOS, %APPDATA% on Windows).
pub fn resolve_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("progress.sqlite"))
}

// ---- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn list_completions(db: State<'_, ProgressDb>) -> Result<Vec<Completion>, String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let mut stmt = conn
        .prepare("SELECT course_id, lesson_id, completed_at FROM completions ORDER BY completed_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Completion {
                course_id: r.get(0)?,
                lesson_id: r.get(1)?,
                completed_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn mark_completion(
    db: State<'_, ProgressDb>,
    course_id: String,
    lesson_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO completions (course_id, lesson_id, completed_at) VALUES (?1, ?2, ?3)",
        params![course_id, lesson_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_completions(db: State<'_, ProgressDb>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute("DELETE FROM completions", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_lesson_completion(
    db: State<'_, ProgressDb>,
    course_id: String,
    lesson_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute(
        "DELETE FROM completions WHERE course_id = ?1 AND lesson_id = ?2",
        params![course_id, lesson_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_course_completions(
    db: State<'_, ProgressDb>,
    course_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute(
        "DELETE FROM completions WHERE course_id = ?1",
        params![course_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
