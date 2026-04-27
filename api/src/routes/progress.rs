//! Progress sync endpoints.
//!
//! Bidirectional sync semantics:
//! - GET returns every completion the API knows about for this user.
//!   The client merges into its local SQLite (keeping whichever
//!   `completed_at` is newer per (course_id, lesson_id) key).
//! - PUT accepts the full local list and upserts; the SQL helper
//!   already keeps the newer `completed_at` on conflict, so this is
//!   commutative across multiple devices syncing in any order.

use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

use super::middleware::UserId;
use crate::db::ProgressRow;
use crate::state::AppState;

pub async fn list(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
) -> Result<Json<Vec<ProgressRow>>, StatusCode> {
    state
        .db
        .list_progress(&user_id)
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
pub struct UpsertBody {
    pub rows: Vec<ProgressRow>,
}

pub async fn upsert(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
    Json(body): Json<UpsertBody>,
) -> Result<StatusCode, StatusCode> {
    if body.rows.len() > 5000 {
        // Cap the bulk size so a single request can't lock the db for
        // minutes. Clients with bigger histories should chunk.
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    state
        .db
        .upsert_progress(&user_id, &body.rows)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}
