//! Per-table query helpers attached to the `Database` handle.
//!
//! Named `users.rs` because every other table dangles off `users` —
//! tokens, progress, and courses all FK to it. Splitting into one
//! file per table is overkill at this size; if any table grows past
//! a hundred lines we'll split it out.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Database, OptionalExt};

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub has_password: bool,
    pub apple_linked: bool,
    pub google_linked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressRow {
    pub course_id: String,
    pub lesson_id: String,
    pub completed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CourseMeta {
    pub id: String,
    pub course_slug: String,
    pub owner_id: String,
    pub owner_display_name: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub language: Option<String>,
    pub visibility: String,
    pub archive_size: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Database {
    // ── Users ────────────────────────────────────────────────

    /// Create or fetch a user by Apple `sub`. Email gets updated when
    /// present so a user who initially signed in without disclosing
    /// their email can later upgrade.
    pub fn find_or_create_apple_user(
        &self,
        apple_user_id: &str,
        email: Option<&str>,
        display_name: Option<&str>,
    ) -> anyhow::Result<String> {
        let conn = self.conn_lock();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM users WHERE apple_user_id = ?1",
                params![apple_user_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            if let Some(e) = email {
                conn.execute(
                    "UPDATE users SET email = COALESCE(email, ?2), updated_at = datetime('now') WHERE id = ?1",
                    params![id, e],
                )?;
            }
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO users (id, email, apple_user_id, display_name) VALUES (?1, ?2, ?3, ?4)",
            params![id, email, apple_user_id, display_name],
        )?;
        Ok(id)
    }

    pub fn find_or_create_google_user(
        &self,
        google_user_id: &str,
        email: Option<&str>,
        display_name: Option<&str>,
    ) -> anyhow::Result<String> {
        let conn = self.conn_lock();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM users WHERE google_user_id = ?1",
                params![google_user_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            if let Some(e) = email {
                conn.execute(
                    "UPDATE users SET email = COALESCE(email, ?2), updated_at = datetime('now') WHERE id = ?1",
                    params![id, e],
                )?;
            }
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO users (id, email, google_user_id, display_name) VALUES (?1, ?2, ?3, ?4)",
            params![id, email, google_user_id, display_name],
        )?;
        Ok(id)
    }

    pub fn create_password_user(
        &self,
        email: &str,
        password_hash: &str,
        display_name: Option<&str>,
    ) -> anyhow::Result<String> {
        let conn = self.conn_lock();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO users (id, email, password_hash, display_name) VALUES (?1, ?2, ?3, ?4)",
            params![id, email, password_hash, display_name],
        )?;
        Ok(id)
    }

    /// Returns (user_id, password_hash) when an email is registered
    /// with a password. Used by the login endpoint to verify the
    /// password before issuing a token.
    pub fn get_password_login(
        &self,
        email: &str,
    ) -> anyhow::Result<Option<(String, String)>> {
        let conn = self.conn_lock();
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT id, password_hash FROM users WHERE email = ?1 AND password_hash IS NOT NULL",
                params![email],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    pub fn email_exists(&self, email: &str) -> anyhow::Result<bool> {
        let conn = self.conn_lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM users WHERE email = ?1",
            params![email],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn get_user(&self, user_id: &str) -> anyhow::Result<Option<User>> {
        let conn = self.conn_lock();
        let row = conn
            .query_row(
                "SELECT id, email, display_name, password_hash IS NOT NULL, apple_user_id IS NOT NULL, google_user_id IS NOT NULL FROM users WHERE id = ?1",
                params![user_id],
                |r| {
                    Ok(User {
                        id: r.get(0)?,
                        email: r.get(1)?,
                        display_name: r.get(2)?,
                        has_password: r.get(3)?,
                        apple_linked: r.get(4)?,
                        google_linked: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn delete_user(&self, user_id: &str) -> anyhow::Result<()> {
        let conn = self.conn_lock();
        // ON DELETE CASCADE on tokens + progress + courses handles the rest.
        conn.execute(
            "DELETE FROM users WHERE id = ?1",
            params![user_id],
        )?;
        Ok(())
    }

    // ── Tokens ───────────────────────────────────────────────

    pub fn store_token(
        &self,
        id: &str,
        user_id: &str,
        label: &str,
        token_hash: &str,
    ) -> anyhow::Result<()> {
        let conn = self.conn_lock();
        conn.execute(
            "INSERT INTO tokens (id, user_id, label, token_hash) VALUES (?1, ?2, ?3, ?4)",
            params![id, user_id, label, token_hash],
        )?;
        Ok(())
    }

    /// Return every (token_id, user_id, hash) row so the auth
    /// middleware can verify a Bearer token by comparing it against
    /// each stored Argon2 hash.
    pub fn all_token_hashes(
        &self,
    ) -> anyhow::Result<Vec<(String, String, String)>> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT id, user_id, token_hash FROM tokens",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn update_token_last_used(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn_lock();
        conn.execute(
            "UPDATE tokens SET last_used = datetime('now') WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn revoke_token(&self, id: &str, user_id: &str) -> anyhow::Result<()> {
        let conn = self.conn_lock();
        conn.execute(
            "DELETE FROM tokens WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
        )?;
        Ok(())
    }

    // ── Progress ─────────────────────────────────────────────

    pub fn list_progress(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<ProgressRow>> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT course_id, lesson_id, completed_at FROM progress WHERE user_id = ?1 ORDER BY completed_at DESC"
        )?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok(ProgressRow {
                    course_id: row.get(0)?,
                    lesson_id: row.get(1)?,
                    completed_at: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Bulk upsert. Newer `completed_at` wins on conflict so two
    /// devices that finish the same lesson on different days don't
    /// undo each other's progress on sync.
    pub fn upsert_progress(
        &self,
        user_id: &str,
        rows: &[ProgressRow],
    ) -> anyhow::Result<()> {
        let conn = self.conn_lock();
        let tx = conn.unchecked_transaction()?;
        for r in rows {
            tx.execute(
                "INSERT INTO progress (user_id, course_id, lesson_id, completed_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, datetime('now'))
                 ON CONFLICT(user_id, course_id, lesson_id) DO UPDATE
                 SET completed_at = MAX(excluded.completed_at, progress.completed_at),
                     updated_at = datetime('now')",
                params![user_id, r.course_id, r.lesson_id, r.completed_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── Courses ──────────────────────────────────────────────

    pub fn create_course(
        &self,
        owner_id: &str,
        course_slug: &str,
        title: &str,
        description: Option<&str>,
        language: Option<&str>,
        visibility: &str,
        archive_blob: &[u8],
    ) -> anyhow::Result<String> {
        let conn = self.conn_lock();
        let id = uuid::Uuid::new_v4().to_string();
        let size = archive_blob.len() as i64;
        conn.execute(
            "INSERT INTO courses (id, course_slug, owner_id, title, description, language, visibility, archive_blob, archive_size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, course_slug, owner_id, title, description, language, visibility, archive_blob, size],
        )?;
        Ok(id)
    }

    pub fn list_user_courses(
        &self,
        owner_id: &str,
    ) -> anyhow::Result<Vec<CourseMeta>> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.course_slug, c.owner_id, u.display_name, c.title, c.description, c.language, c.visibility, c.archive_size, c.created_at, c.updated_at
             FROM courses c
             LEFT JOIN users u ON u.id = c.owner_id
             WHERE c.owner_id = ?1
             ORDER BY c.updated_at DESC"
        )?;
        let rows = stmt
            .query_map(params![owner_id], course_meta_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_public_courses(
        &self,
        limit: i64,
    ) -> anyhow::Result<Vec<CourseMeta>> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.course_slug, c.owner_id, u.display_name, c.title, c.description, c.language, c.visibility, c.archive_size, c.created_at, c.updated_at
             FROM courses c
             LEFT JOIN users u ON u.id = c.owner_id
             WHERE c.visibility = 'public'
             ORDER BY c.updated_at DESC
             LIMIT ?1"
        )?;
        let rows = stmt
            .query_map(params![limit], course_meta_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Returns the full archive blob + meta. Owner can fetch their own
    /// private courses; anyone can fetch a public/unlisted one by id.
    pub fn get_course(
        &self,
        course_id: &str,
        viewer_id: Option<&str>,
    ) -> anyhow::Result<Option<(CourseMeta, Vec<u8>)>> {
        let conn = self.conn_lock();
        let row = conn
            .query_row(
                "SELECT c.id, c.course_slug, c.owner_id, u.display_name, c.title, c.description, c.language, c.visibility, c.archive_size, c.created_at, c.updated_at, c.archive_blob
                 FROM courses c
                 LEFT JOIN users u ON u.id = c.owner_id
                 WHERE c.id = ?1",
                params![course_id],
                |row| {
                    Ok((
                        CourseMeta {
                            id: row.get(0)?,
                            course_slug: row.get(1)?,
                            owner_id: row.get(2)?,
                            owner_display_name: row.get(3)?,
                            title: row.get(4)?,
                            description: row.get(5)?,
                            language: row.get(6)?,
                            visibility: row.get(7)?,
                            archive_size: row.get(8)?,
                            created_at: row.get(9)?,
                            updated_at: row.get(10)?,
                        },
                        row.get::<_, Vec<u8>>(11)?,
                    ))
                },
            )
            .optional()?;
        match row {
            Some((meta, blob)) => {
                if meta.visibility == "private" && viewer_id != Some(&meta.owner_id) {
                    Ok(None)
                } else {
                    Ok(Some((meta, blob)))
                }
            }
            None => Ok(None),
        }
    }

    pub fn delete_course(
        &self,
        course_id: &str,
        owner_id: &str,
    ) -> anyhow::Result<bool> {
        let conn = self.conn_lock();
        let n = conn.execute(
            "DELETE FROM courses WHERE id = ?1 AND owner_id = ?2",
            params![course_id, owner_id],
        )?;
        Ok(n > 0)
    }
}

fn course_meta_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CourseMeta> {
    Ok(CourseMeta {
        id: row.get(0)?,
        course_slug: row.get(1)?,
        owner_id: row.get(2)?,
        owner_display_name: row.get(3)?,
        title: row.get(4)?,
        description: row.get(5)?,
        language: row.get(6)?,
        visibility: row.get(7)?,
        archive_size: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}
