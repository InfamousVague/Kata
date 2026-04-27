//! SQLite database handle for the Fishbones API.
//!
//! Single-file SQLite under WAL with foreign keys on. The schema is
//! deliberately small — four tables (`users`, `tokens`, `progress`,
//! `courses`) — and all the per-table queries live in `users.rs`
//! (named that way because every table dangles off `users`; the file
//! holds course/progress/token helpers too).
//!
//! `conn_lock()` is the one path through to the underlying connection;
//! every helper takes the mutex via that method so we never end up
//! with two paths fighting over locking semantics.

mod users;

pub use users::{CourseMeta, ProgressRow, User};

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Open (or create) the SQLite file at `path`. The parent dir is
    /// created if missing — handy for the default
    /// `/var/lib/fishbones-api/api.sqlite` location where systemd
    /// only owns the dir, not the file.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn run_migrations(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(MIGRATIONS)?;
        Ok(())
    }

    /// Lend the connection mutex out to `users.rs`. `pub(crate)` so
    /// the curated API in `users.rs` is the only entry point — handler
    /// code never touches raw SQL.
    pub(crate) fn conn_lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }
}

/// rusqlite's `query_row` returns `Err(QueryReturnedNoRows)` for the
/// not-found case; we promote that to `Ok(None)` so the call sites
/// can pattern-match cleanly.
pub(crate) trait OptionalExt<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}
impl<T> OptionalExt<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

const MIGRATIONS: &str = r#"
-- Users. Keep email-password, Apple, and Google identity columns side
-- by side so a future "link your Google account to an existing email
-- login" feature is just an UPDATE — no second-table dance.
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT UNIQUE,
    password_hash   TEXT,
    apple_user_id   TEXT UNIQUE,
    google_user_id  TEXT UNIQUE,
    display_name    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-device API tokens. Argon2id-hashed so a database leak doesn't
-- leak live bearers. ON DELETE CASCADE sweeps tokens when an account
-- is deleted.
CREATE TABLE IF NOT EXISTS tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    last_used   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-lesson completion records. The composite primary key keeps the
-- upsert idempotent — pushing the same lesson twice from two devices
-- updates the timestamp instead of creating a duplicate row.
CREATE TABLE IF NOT EXISTS progress (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id     TEXT NOT NULL,
    lesson_id     TEXT NOT NULL,
    completed_at  TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, course_id, lesson_id)
);

-- Course archives. Stores the `.fishbones` zip blob inline so the
-- API can be a single binary + db file with no separate object
-- store. Cap enforced at the API layer (~50 MB) to keep the SQLite
-- page count reasonable.
CREATE TABLE IF NOT EXISTS courses (
    id            TEXT PRIMARY KEY,
    course_slug   TEXT NOT NULL,
    owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    description   TEXT,
    language      TEXT,
    visibility    TEXT NOT NULL DEFAULT 'private',
    archive_blob  BLOB NOT NULL,
    archive_size  INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_courses_owner
    ON courses(owner_id);
CREATE INDEX IF NOT EXISTS idx_courses_visibility
    ON courses(visibility, updated_at);
"#;
