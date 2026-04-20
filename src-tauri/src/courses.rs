//! Course loading + import/export.
//!
//! At rest, a course is a folder in `<app_data_dir>/courses/<course-id>/` with
//! a `course.json` at its root:
//!
//! ```json
//! { "id": "rust-book", "title": "...", "language": "rust",
//!   "chapters": [ { "id":"...", "title":"...", "lessons":[ ... ] } ] }
//! ```
//!
//! Lessons are inlined in the JSON for V1 (no separate .md files yet). A
//! future step will split prose out into sibling .md files.
//!
//! Share/export uses a `.kata` archive — a zip of the course folder. Import
//! unpacks the archive into `<app_data_dir>/courses/<course-id>/`.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::progress_db::ProgressDb;

/// Matches the shape of the frontend Course type in `src/data/types.ts`. We
/// pass-through as serde_json::Value so the Rust side doesn't need to mirror
/// every lesson-kind discriminator — if the frontend's types evolve, we don't
/// need to re-deploy the native side.
pub type CourseJson = serde_json::Value;

pub struct CourseRoots(pub Vec<PathBuf>);

/// Resolve the directories we scan for courses. Currently just the app data
/// dir's `courses/` folder; bundled defaults are copied here on first launch.
pub fn courses_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?;
    let courses = dir.join("courses");
    fs::create_dir_all(&courses)?;
    Ok(courses)
}

/// If the courses dir is empty (first launch), seed it with the defaults
/// bundled by the ingest CLI / the repo's `courses/` folder (copied at build
/// time into resources). For V1 this is a no-op — the frontend still has
/// `seedCourses` and will write them out on first run via `save_course`.
pub fn ensure_seed(_app: &tauri::AppHandle) -> anyhow::Result<()> {
    Ok(())
}

// ---- Commands ---------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct CourseEntry {
    pub id: String,
    pub path: String,
    pub title: String,
    pub language: String,
}

/// List every course the app can see. Returns a lightweight manifest entry,
/// not the full course body — the frontend calls `load_course(id)` to get
/// the details.
#[tauri::command]
pub fn list_courses(app: tauri::AppHandle) -> Result<Vec<CourseEntry>, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let course_json = path.join("course.json");
        if !course_json.exists() { continue; }
        match read_course_json(&course_json) {
            Ok(v) => out.push(CourseEntry {
                id: str_field(&v, "id"),
                path: path.to_string_lossy().into_owned(),
                title: str_field(&v, "title"),
                language: str_field(&v, "language"),
            }),
            Err(_) => continue,
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn load_course(app: tauri::AppHandle, course_id: String) -> Result<CourseJson, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_json = dir.join(&course_id).join("course.json");
    read_course_json(&course_json).map_err(|e| e.to_string())
}

/// Write a course's full JSON to disk. Used by the frontend's seeder to
/// materialize built-in courses into the app data dir on first run, and
/// (later) by the ingest importer.
#[tauri::command]
pub fn save_course(app: tauri::AppHandle, course_id: String, body: CourseJson) -> Result<(), String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_dir = dir.join(&course_id);
    fs::create_dir_all(&course_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;
    fs::write(course_dir.join("course.json"), json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a course folder and all its progress rows.
#[tauri::command]
pub fn delete_course(
    app: tauri::AppHandle,
    db: State<'_, ProgressDb>,
    course_id: String,
) -> Result<(), String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_dir = dir.join(&course_id);
    if course_dir.exists() {
        fs::remove_dir_all(&course_dir).map_err(|e| e.to_string())?;
    }
    let conn = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    conn.execute("DELETE FROM completions WHERE course_id = ?1", [&course_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Export a course as a `.kata` zip archive at the chosen destination path.
#[tauri::command]
pub fn export_course(
    app: tauri::AppHandle,
    course_id: String,
    destination: String,
) -> Result<(), String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_dir = dir.join(&course_id);
    if !course_dir.is_dir() {
        return Err(format!("course '{course_id}' not found"));
    }
    zip_dir(&course_dir, Path::new(&destination)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Import a `.kata` archive, extracting it into app_data_dir/courses/<id>/.
/// The archive's course.json determines the id.
#[tauri::command]
pub fn import_course(app: tauri::AppHandle, archive_path: String) -> Result<String, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_id = unzip_to(&Path::new(&archive_path), &dir).map_err(|e| e.to_string())?;
    Ok(course_id)
}

// ---- Helpers ----------------------------------------------------------------

fn read_course_json(path: &Path) -> anyhow::Result<CourseJson> {
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn str_field(v: &CourseJson, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn zip_dir(src: &Path, dst: &Path) -> anyhow::Result<()> {
    let file = fs::File::create(dst)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in walkdir::WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        let rel = path.strip_prefix(src)?;
        if rel.as_os_str().is_empty() { continue; }
        if path.is_dir() {
            writer.add_directory(rel.to_string_lossy(), options)?;
        } else {
            writer.start_file(rel.to_string_lossy(), options)?;
            let mut f = fs::File::open(path)?;
            std::io::copy(&mut f, &mut writer)?;
        }
    }
    writer.finish()?;
    Ok(())
}

/// Extract the .kata file into `courses_dir`. Returns the course id (read
/// from the archive's course.json) so the frontend can navigate to it.
fn unzip_to(archive: &Path, courses_dir: &Path) -> anyhow::Result<String> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;

    // First pass: read course.json (wherever in the archive it is) to get id.
    let mut id = String::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.name().ends_with("course.json") && !entry.is_dir() {
            let mut buf = String::new();
            entry.read_to_string(&mut buf)?;
            let v: CourseJson = serde_json::from_str(&buf)?;
            id = str_field(&v, "id");
            break;
        }
    }
    if id.is_empty() {
        anyhow::bail!("course.json not found or missing 'id' in archive");
    }

    let dest = courses_dir.join(&id);
    if dest.exists() {
        fs::remove_dir_all(&dest)?;
    }
    fs::create_dir_all(&dest)?;

    // Second pass: extract everything, flattening any top-level wrapper dir
    // in the archive (e.g. `my-course/course.json` becomes `course.json`).
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_owned();
        let rel = strip_top_level(&name);
        if rel.is_empty() { continue; }
        let out_path = dest.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut f = fs::File::create(&out_path)?;
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            f.write_all(&buf)?;
        }
    }
    Ok(id)
}

fn strip_top_level(path: &str) -> String {
    // If the zip contains a single top-level folder wrapping course.json, skip
    // it. Otherwise return as-is. This lets people share `my-course.kata`
    // created from a folder OR from its contents.
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() > 1 {
        parts[1..].join("/")
    } else if path.ends_with('/') {
        String::new() // skip top-level dir itself
    } else {
        path.to_string()
    }
}
