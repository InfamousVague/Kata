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
//! Share/export uses a `.fishbones` archive — a zip of the course folder.
//! Legacy `.kata` archives are still accepted on import for backwards compat.
//! Import unpacks the archive into `<app_data_dir>/courses/<course-id>/`.

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

/// Bump this when the bundled-packs content changes meaningfully (new
/// lessons added, drill stacks authored, lesson bodies refreshed) and
/// you want EXISTING installs to pick up the updates on their next
/// launch without an uninstall. The persisted seed_version in
/// `seeded-packs.json` is compared to this constant; if it's lower,
/// every pack the user still has installed gets RE-EXTRACTED from the
/// bundled archive (course.json overwritten, cover.png refreshed).
/// User-deleted packs (tracked by id in `seed_ids`) stay deleted.
///
/// The first launch after a bump prints a one-line refresh message;
/// subsequent launches are no-ops as before.
///
/// History:
///   1 — Initial. Adds the version concept itself; refreshes existing
///       installs so they pick up the 147 micropuzzle drills (792
///       cards) added across 11 tutorial courses.
///   2 — Library promotion. The dev's local library was zipped over
///       the previous bundled-packs (`scripts/promote-library-to-bundle.mjs`)
///       to ship 18 newly-imported books (Eloquent JS, Rust Book,
///       Python Crash Course, Mastering Bitcoin/Ethereum/Lightning,
///       Solana Programs, Solidity Complete, Vyper, Viem/Ethers, Three.js,
///       React Native, Fluent React, Svelte tutorial, Cryptography
///       Fundamentals, JavaScript The Definitive Guide, Learning Go,
///       Learning React Native) plus refreshed challenge packs. Existing
///       installs re-extract on next launch.
///   3 — Library retirement. Drops four books that shipped in earlier
///       bundles but were retired (`bun-complete`, `bun-fundamentals`,
///       `svelte-5-complete`, `javascript-crash-course`). Existing
///       desktop / mobile installs that still have these on disk get
///       them removed on next launch. Mirrors the web seeder's V6
///       LEGACY_STARTER_IDS prune (Apps/Fishbones/src/data/webSeedCourses.ts)
///       so all three platforms drop the same retirees in lockstep.
const SEED_VERSION: u32 = 8;

/// Ids that previously shipped via `resources/bundled-packs/` but have
/// since been retired. On a SEED_VERSION bump, ensure_seed deletes
/// these from the user's courses dir if they're still present — same
/// migration story the web seeder has via LEGACY_STARTER_IDS, kept in
/// sync so a learner with installs on multiple platforms sees the
/// shelf converge to the current shipped set after one launch each.
///
/// Don't trim this list when adding new retirees; an install that's
/// been dormant since the very first version still needs the older
/// ids cleaned up on its next launch.
const RETIRED_PACK_IDS: &[&str] = &[
    "bun-complete",
    "bun-fundamentals",
    "svelte-5-complete",
    "javascript-crash-course",
    "challenges-reactnative-visual",
];

/// Import any `.fishbones` / `.kata` archives bundled under
/// `resources/bundled-packs/` into the user's courses dir on first launch.
/// Idempotent — never overwrites an existing course (unless SEED_VERSION
/// has bumped, see above), and records every id we've seeded into
/// `<app-data>/seeded-packs.json` so a user-deleted pack stays deleted
/// instead of getting resurrected on the next run.
///
/// This is the entry point that ships the default Rust / TypeScript / Go
/// challenge packs along with Fishbones. Drop a `.fishbones` (or legacy
/// `.kata`) file in `src-tauri/resources/bundled-packs/`, commit it, and
/// new installs pick it up automatically.
pub fn ensure_seed(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let resource_dir = match app.path().resource_dir() {
        Ok(p) => p.join("resources").join("bundled-packs"),
        Err(_) => return Ok(()), // no resource dir (rare) — nothing to seed
    };
    if !resource_dir.exists() {
        return Ok(()); // no bundled packs shipped in this build
    }

    let courses_root = courses_dir(app)?;
    let marker = marker_path(app)?;
    let mut packs = load_seeded_packs(&marker).unwrap_or_default();
    // Refresh-mode: when the persisted seed_version is older than the
    // current SEED_VERSION, we treat already-installed packs as
    // candidates for re-extract. User-deleted packs (in seed_ids but
    // not on disk) still stay deleted.
    let needs_refresh = packs.seed_version < SEED_VERSION;

    // Prune retired packs first. Only fires on a version bump so we
    // don't waste IO on every cold start. We delete the course dir
    // wholesale (course.json, cover.png, lesson assets) — progress
    // lives in progress.sqlite which we leave alone, so if a future
    // build ever resurrects a retired id the completion history is
    // still there. We DON'T add the retired id to seed_ids: with the
    // .fishbones already gone from bundled-packs/ it would never be
    // re-imported anyway, and leaving seed_ids untouched lets a
    // future bundle re-introduce the id without needing a marker
    // surgery.
    let mut pruned_this_run = 0u32;
    if needs_refresh {
        for retired in RETIRED_PACK_IDS {
            let dir = courses_root.join(retired);
            if !dir.exists() {
                continue;
            }
            match fs::remove_dir_all(&dir) {
                Ok(()) => {
                    pruned_this_run += 1;
                    // Drop the id from seed_ids if it's there so the
                    // marker doesn't carry around dead entries forever.
                    packs.seed_ids.retain(|id| id != retired);
                }
                Err(e) => {
                    eprintln!(
                        "[fishbones:seed] failed to prune retired pack {:?}: {}",
                        dir, e
                    );
                }
            }
        }
    }

    let mut imported_this_run = 0u32;
    let mut refreshed_this_run = 0u32;
    for entry in fs::read_dir(&resource_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        match path.extension().and_then(|s| s.to_str()) {
            Some("fishbones") | Some("kata") => {}
            _ => continue,
        }

        // Peek at the course id in the archive so we can decide BEFORE
        // doing any extraction work.
        let id = match peek_archive_id(&path) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("[fishbones:seed] could not read id from {:?}: {}", path, e);
                continue;
            }
        };
        if id.is_empty() {
            continue;
        }

        let course_exists = courses_root.join(&id).join("course.json").exists();

        if course_exists {
            // Make sure the marker knows we've effectively seeded this id
            // so the user can delete it later and we won't re-import.
            if !packs.seed_ids.contains(&id) {
                packs.seed_ids.push(id.clone());
            }
            // Refresh path — we have an installed copy AND the
            // persisted seed_version is older than the current. Wipe
            // and re-extract so the user picks up new lessons / drills
            // / cover artwork without an uninstall. Progress lives in
            // progress.sqlite (separate file) so completions survive.
            if needs_refresh {
                if let Err(e) = unzip_to(&path, &courses_root) {
                    eprintln!(
                        "[fishbones:seed] refresh-extract failed for {:?}: {}",
                        path, e
                    );
                    continue;
                }
                refreshed_this_run += 1;
            }
            continue;
        }

        // User previously had it + deleted — respect that decision.
        if packs.seed_ids.contains(&id) {
            continue;
        }

        // Fresh seed — extract into the courses dir.
        if let Err(e) = unzip_to(&path, &courses_root) {
            eprintln!("[fishbones:seed] unzip failed for {:?}: {}", path, e);
            continue;
        }
        packs.seed_ids.push(id);
        imported_this_run += 1;
    }

    if imported_this_run > 0 {
        eprintln!(
            "[fishbones:seed] imported {} bundled pack(s) from {:?}",
            imported_this_run, resource_dir
        );
    }
    if refreshed_this_run > 0 {
        eprintln!(
            "[fishbones:seed] refreshed {} pack(s) (seed_version {} → {})",
            refreshed_this_run, packs.seed_version, SEED_VERSION
        );
    }
    if pruned_this_run > 0 {
        eprintln!(
            "[fishbones:seed] pruned {} retired pack(s) on seed_version bump",
            pruned_this_run
        );
    }
    // Always advance the persisted seed_version so the next launch
    // knows it's caught up. Even if zero packs needed refresh (e.g.
    // user deleted them all), we mark this version as applied so
    // we don't re-evaluate on every launch.
    packs.seed_version = SEED_VERSION;
    save_seeded_packs(&marker, &packs)?;
    Ok(())
}

/// `<app-data>/seeded-packs.json` — a flat `{ "seedIds": [...] }` JSON.
/// Tracks every pack id we've ever auto-imported on this machine. If the
/// user deletes one, we keep the id here forever so we never resurrect
/// it on a subsequent launch. Cheap + resilient — losing the file just
/// means we seed once more, which is still a no-op if the course dir
/// already has the pack.
fn marker_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("seeded-packs.json"))
}

/// On-disk shape of `<app-data>/seeded-packs.json`. The `seedVersion`
/// field was added later; older marker files (without it) deserialise
/// with `seed_version: 0` via `#[serde(default)]`, which is exactly
/// what we want — those installs get re-evaluated against the
/// current SEED_VERSION on the next launch and refreshed in place.
#[derive(Default, Serialize, Deserialize)]
struct SeededPacks {
    #[serde(default, rename = "seedIds")]
    seed_ids: Vec<String>,
    #[serde(default, rename = "seedVersion")]
    seed_version: u32,
}

fn load_seeded_packs(path: &Path) -> anyhow::Result<SeededPacks> {
    if !path.exists() {
        return Ok(SeededPacks::default());
    }
    let bytes = fs::read(path)?;
    let parsed: SeededPacks = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(parsed)
}

fn save_seeded_packs(path: &Path, packs: &SeededPacks) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec_pretty(packs)?;
    fs::write(path, bytes)?;
    Ok(())
}

/// Read ONLY the course id out of a .fishbones/.kata archive without
/// extracting anything. Used by the seed routine to decide whether to skip.
fn peek_archive_id(archive: &Path) -> anyhow::Result<String> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.name().ends_with("course.json") && !entry.is_dir() {
            let mut buf = String::new();
            entry.read_to_string(&mut buf)?;
            let v: CourseJson = serde_json::from_str(&buf)?;
            return Ok(str_field(&v, "id"));
        }
    }
    anyhow::bail!("course.json not found in archive");
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

/// Return EVERY course's JSON in one shot, but with the heavy per-lesson
/// bodies stripped out: `starter`, `solution`, `tests`, `files`,
/// `solutionFiles`, and prose/markdown/content fields are removed.
/// Chapter + lesson titles, ids, difficulty, topic, and kind are kept —
/// which is everything the library, sidebar, and progress UI need to
/// render.
///
/// Why this exists: a full library load used to fire N parallel
/// `load_course` IPCs, each shipping megabytes of JSON across the
/// bridge and deserialising on the webview's main thread. For a
/// realistic library (~24 courses, ~12 MB of JSON) the app sat hung
/// for 1-3 seconds on every launch. Stripping bodies cuts the payload
/// by ~75% and collapses N IPCs into 1. Lesson bodies are fetched
/// on-demand through the existing `load_course` when the learner
/// actually opens a lesson.
#[tauri::command]
pub fn list_courses_summary(app: tauri::AppHandle) -> Result<Vec<CourseJson>, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let course_json = path.join("course.json");
        if !course_json.exists() {
            continue;
        }
        match read_course_json(&course_json) {
            Ok(mut v) => {
                strip_lesson_bodies(&mut v);
                out.push(v);
            }
            Err(_) => continue,
        }
    }
    Ok(out)
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

/// Export a course as a `.fishbones` zip archive at the chosen destination path.
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

/// Import a `.fishbones` / `.kata` archive, extracting it into
/// app_data_dir/courses/<id>/. The archive's course.json determines the id.
#[tauri::command]
pub fn import_course(app: tauri::AppHandle, archive_path: String) -> Result<String, String> {
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;
    let course_id = unzip_to(&Path::new(&archive_path), &dir).map_err(|e| e.to_string())?;
    Ok(course_id)
}

/// Walk up from cwd + the running binary's dir looking for a folder
/// that contains BOTH `package.json` and `public/starter-courses/`.
/// That signature uniquely identifies the Fishbones repo root in dev
/// (where the binary lives at `src-tauri/target/debug/`) without
/// misfiring on someone else's checkout. Returns None when not found
/// (production builds, foreign cwd) — callers turn that into a
/// friendly error.
fn find_repo_root_for_starter_promotion() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
        }
    }
    for start in candidates {
        let mut cur: &Path = start.as_path();
        loop {
            if cur.join("package.json").is_file()
                && cur.join("public").join("starter-courses").is_dir()
            {
                return Some(cur.to_path_buf());
            }
            match cur.parent() {
                Some(p) => cur = p,
                None => break,
            }
        }
    }
    None
}

/// Dev-only: write the supplied course JSON into
/// `<repo>/public/starter-courses/<courseId>.json` so the next install
/// picks up the in-app fixes. Refuses on release builds (the user is
/// running an installed app, not a dev tree) and when the repo root
/// can't be located.
#[tauri::command]
pub fn save_bundled_starter_course(course_id: String, body: CourseJson) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err(
            "Promote-to-bundled is only available in `tauri dev` builds; this is a release binary."
                .into(),
        );
    }
    if course_id.is_empty()
        || !course_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid course id (expected url-safe alphanumeric)".into());
    }
    let repo = find_repo_root_for_starter_promotion().ok_or_else(|| {
        "Couldn't locate the Fishbones repo root from this binary — are you running via `npm run tauri:dev`?"
            .to_string()
    })?;
    let dest = repo
        .join("public")
        .join("starter-courses")
        .join(format!("{course_id}.json"));
    let serialized = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&dest, &serialized).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Fetch a remote `.fishbones` archive over HTTPS and install it into
/// the user's courses dir. Used by the catalog's "Install" button on
/// remote-tier placeholders. Returns the in-zip course id on success.
#[tauri::command]
pub async fn download_and_install_course(
    app: tauri::AppHandle,
    archive_url: String,
) -> Result<String, String> {
    if !archive_url.starts_with("https://") {
        return Err(format!(
            "archive URL must use HTTPS (got: {archive_url})"
        ));
    }
    let dir = courses_dir(&app).map_err(|e| e.to_string())?;

    // Fetch via reqwest (rustls already enabled in Cargo.toml).
    let bytes = reqwest::get(&archive_url)
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download stream failed: {e}"))?;

    // Stage to a temp file so unzip_to can read by path. We use a
    // unique name per call so concurrent installs don't collide.
    let tmp = std::env::temp_dir().join(format!(
        "fishbones-install-{}.fishbones",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::write(&tmp, &bytes).map_err(|e| format!("write temp archive failed: {e}"))?;

    let course_id = unzip_to(&tmp, &dir).map_err(|e| e.to_string())?;

    // Best-effort cleanup of the temp file — the install succeeds
    // either way.
    let _ = fs::remove_file(&tmp);
    Ok(course_id)
}

/// Counts returned to the UI after a manual sync. The frontend uses
/// these to render a one-line status ("Synced 1 new course" / "Already
/// up to date" / "Refreshed 12 packs") so the button gives the learner
/// concrete feedback instead of disappearing-spinner anxiety.
#[derive(Debug, Default, Serialize)]
pub struct RefreshReport {
    /// Packs that weren't on disk before this call. New books picked
    /// up from the binary's bundled-packs/ since the last sync.
    #[serde(rename = "new")]
    pub new_count: u32,
    /// Packs that already existed and got re-extracted in place. Lesson
    /// updates, drill stacks, cover changes — all land here.
    pub refreshed: u32,
    /// Packs the user had previously seeded then deleted (id in
    /// seed_ids but folder absent). We respect the deletion and DO NOT
    /// resurrect the pack — it's reported here so the UI can hint at
    /// it ("3 packs you deleted are still hidden").
    pub skipped_deleted: u32,
}

/// User-triggered "Sync latest courses" — re-extracts every bundled
/// pack that's still installed AND seeds any new packs that have landed
/// in `resources/bundled-packs/` since the last sync. Unlike
/// `ensure_seed` (which only refreshes when SEED_VERSION bumps), this
/// always re-extracts so the user can pull in mid-version updates.
/// User-deleted packs stay deleted (tracked by id in `seed_ids`).
///
/// Wired to the "Sync latest courses" button in Settings → Data.
#[tauri::command]
pub fn refresh_bundled_courses(app: tauri::AppHandle) -> Result<RefreshReport, String> {
    let resource_dir = match app.path().resource_dir() {
        Ok(p) => p.join("resources").join("bundled-packs"),
        Err(_) => return Ok(RefreshReport::default()),
    };
    if !resource_dir.exists() {
        return Ok(RefreshReport::default());
    }

    let courses_root = courses_dir(&app).map_err(|e| e.to_string())?;
    let marker = marker_path(&app).map_err(|e| e.to_string())?;
    let mut packs = load_seeded_packs(&marker).unwrap_or_default();
    let mut report = RefreshReport::default();

    let read_dir = match fs::read_dir(&resource_dir) {
        Ok(r) => r,
        Err(e) => return Err(format!("read bundled-packs dir: {e}")),
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        match path.extension().and_then(|s| s.to_str()) {
            Some("fishbones") | Some("kata") => {}
            _ => continue,
        }

        let id = match peek_archive_id(&path) {
            Ok(id) if !id.is_empty() => id,
            Ok(_) => continue,
            Err(e) => {
                eprintln!("[fishbones:refresh] could not read id from {:?}: {}", path, e);
                continue;
            }
        };

        let course_exists = courses_root.join(&id).join("course.json").exists();

        if course_exists {
            // Always re-extract in force-refresh mode. The marker
            // lookup is just defensive — a manually-imported pack with
            // the same id as a bundled one might not be in seed_ids,
            // and we want to claim it once we replace its contents.
            if !packs.seed_ids.contains(&id) {
                packs.seed_ids.push(id.clone());
            }
            if let Err(e) = unzip_to(&path, &courses_root) {
                eprintln!(
                    "[fishbones:refresh] re-extract failed for {:?}: {}",
                    path, e
                );
                continue;
            }
            report.refreshed += 1;
            continue;
        }

        // User had it + deleted — respect that.
        if packs.seed_ids.contains(&id) {
            report.skipped_deleted += 1;
            continue;
        }

        // Brand-new pack — fresh seed.
        if let Err(e) = unzip_to(&path, &courses_root) {
            eprintln!("[fishbones:refresh] unzip failed for {:?}: {}", path, e);
            continue;
        }
        packs.seed_ids.push(id);
        report.new_count += 1;
    }

    // Persist marker. We DON'T touch seed_version here — that's the
    // launch-path's responsibility. Manual sync just records new
    // ids; the version-gated upgrade behavior stays as-is.
    if let Err(e) = save_seeded_packs(&marker, &packs) {
        eprintln!("[fishbones:refresh] failed to save marker: {}", e);
    }
    eprintln!(
        "[fishbones:refresh] new={} refreshed={} skipped_deleted={}",
        report.new_count, report.refreshed, report.skipped_deleted
    );
    Ok(report)
}

// ---- Helpers ----------------------------------------------------------------

fn read_course_json(path: &Path) -> anyhow::Result<CourseJson> {
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Mutate a course JSON in place to drop every per-lesson field that
/// carries a big code/prose payload. Used by `list_courses_summary`
/// to shrink the initial-load IPC from ~12 MB down to ~3 MB on a
/// typical library. If a future schema adds another heavy field,
/// add it here — silent-keeping it would resurrect the slow startup
/// the summary command was designed to prevent.
fn strip_lesson_bodies(course: &mut CourseJson) {
    const HEAVY_FIELDS: &[&str] = &[
        // Exercise lesson body (code challenges)
        "starter",
        "solution",
        "tests",
        "files",
        "solutionFiles",
        // Reading-lesson prose — same field can appear under a few
        // names historically; drop them all defensively.
        "prose",
        "content",
        "body",
        "markdown",
    ];
    let Some(chapters) = course.get_mut("chapters").and_then(|c| c.as_array_mut()) else {
        return;
    };
    for chapter in chapters.iter_mut() {
        let Some(lessons) = chapter.get_mut("lessons").and_then(|l| l.as_array_mut()) else {
            continue;
        };
        for lesson in lessons.iter_mut() {
            let Some(obj) = lesson.as_object_mut() else {
                continue;
            };
            for field in HEAVY_FIELDS {
                obj.remove(*field);
            }
        }
    }
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

/// Extract the archive file into `courses_dir`. Returns the course id (read
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
    // it. Otherwise return as-is. This lets people share `my-course.fishbones`
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
