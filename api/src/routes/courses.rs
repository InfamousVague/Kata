//! Course-archive upload + share endpoints.
//!
//! The client sends a `.fishbones` zip as a base64 string in JSON —
//! simpler than multipart because the existing CORS / rate-limit
//! middleware just works, and the archives are small enough (<50 MB)
//! that the encoding overhead doesn't matter. Visibility is one of
//! `private` (owner only), `unlisted` (anyone with the id), `public`
//! (listable in the discovery feed).

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use base64::Engine;
use serde::Deserialize;
use std::sync::Arc;

use super::middleware::UserId;
use crate::db::CourseMeta;
use crate::state::AppState;

const MAX_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Deserialize)]
pub struct UploadRequest {
    pub course_slug: String,
    pub title: String,
    pub description: Option<String>,
    pub language: Option<String>,
    pub visibility: Option<String>, // "private" | "unlisted" | "public"
    /// Base64-encoded `.fishbones` zip.
    pub archive_b64: String,
}

pub async fn upload(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
    Json(body): Json<UploadRequest>,
) -> Result<Json<CourseMeta>, StatusCode> {
    let visibility = match body.visibility.as_deref().unwrap_or("private") {
        v @ ("private" | "unlisted" | "public") => v.to_string(),
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    let archive = base64::engine::general_purpose::STANDARD
        .decode(body.archive_b64.as_bytes())
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if archive.len() > MAX_ARCHIVE_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    if archive.len() < 4 || &archive[..4] != b"PK\x03\x04" {
        // Not a zip — guard against the client posting raw JSON or a
        // truncated upload that would just sit useless in the table.
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = state
        .db
        .create_course(
            &user_id,
            body.course_slug.trim(),
            body.title.trim(),
            body.description.as_deref(),
            body.language.as_deref(),
            &visibility,
            &archive,
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let meta = state
        .db
        .get_course(&id, Some(&user_id))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(meta.0))
}

pub async fn list_mine(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
) -> Result<Json<Vec<CourseMeta>>, StatusCode> {
    state
        .db
        .list_user_courses(&user_id)
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn list_public(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<CourseMeta>>, StatusCode> {
    state
        .db
        .list_public_courses(100)
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Stream the raw `.fishbones` zip back. Owner-private courses gate on
/// the requester's user id; public/unlisted courses go through to
/// anyone with the id.
pub async fn download(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
    Path(id): Path<String>,
) -> Result<Response, StatusCode> {
    let (meta, blob) = state
        .db
        .get_course(&id, Some(&user_id))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let filename = format!("{}.fishbones", meta.course_slug);
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        blob,
    )
        .into_response())
}

pub async fn delete_course(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let removed = state
        .db
        .delete_course(&id, &user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
