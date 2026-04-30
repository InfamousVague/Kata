//! Shared application state.
//!
//! Wrapped in `Arc<AppState>` and threaded through every handler via
//! `axum::extract::State`. Provider config knobs are `Option<String>`
//! so a missing env var produces a clean 503 from the affected route
//! instead of a panic at boot — partial deploys (Apple-only or
//! Google-only) are a supported configuration.

use crate::db::Database;
use crate::mailer::Mailer;

pub struct AppState {
    pub db: Database,
    /// Transactional email sender. Always present; falls back to a
    /// `tracing::warn!` log when Resend isn't configured so the
    /// password-reset flow still works on a fresh / dev deploy
    /// (admin reads the URL out of journalctl).
    pub mailer: Mailer,
    /// Web URL the password-reset email links to. Built from
    /// `WEB_BASE_URL` (defaults to `https://fishbones.academy`). The
    /// reset link shape is `<web_base_url>/reset-password?token=…`.
    pub web_base_url: String,

    // ── Sign in with Apple ──────────────────────────────────────
    /// Apple Sign-In Service ID — used as the JWT audience claim
    /// when verifying client `identity_token`s. Loaded from
    /// `APPLE_CLIENT_ID`. `None` disables the Apple sign-in route
    /// with `503`.
    pub apple_audience: Option<String>,
    /// Apple Team ID (10-char alphanum, e.g. `F6ZAL7ANAD`). Used
    /// as the `iss` claim of the per-request client_secret JWT.
    pub apple_team_id: Option<String>,
    /// Apple Key ID — the identifier of the `.p8` you downloaded
    /// from the developer portal. Goes into the JWT `kid` header.
    pub apple_key_id: Option<String>,
    /// Contents of the `.p8` private key file (PEM-encoded).
    /// Loaded from `APPLE_PRIVATE_KEY_PEM` directly OR from a path
    /// in `APPLE_PRIVATE_KEY_FILE`.
    pub apple_private_key_pem: Option<String>,
    /// Path on disk to the `apple-developer-domain-association.txt`
    /// file Apple's portal hands out when you save a Service ID's
    /// SIWA configuration. The `/.well-known/...` route reads it on
    /// each request so dropping in a new file (`scp`) takes effect
    /// without restarting the API.
    pub apple_domain_association_file: Option<String>,

    // ── Sign in with Google ─────────────────────────────────────
    /// Google OAuth client id (web or iOS, whichever Fishbones
    /// ships with). Audience for verifying Google `id_token`s.
    /// Loaded from `GOOGLE_CLIENT_ID`. `None` disables Google
    /// sign-in.
    pub google_audience: Option<String>,
    /// Google OAuth client secret. Required for the browser-OAuth
    /// (PKCE + secret) code-exchange step on
    /// `/auth/google/callback`. The pure native-token path doesn't
    /// need it.
    pub google_client_secret: Option<String>,

    // ── Server config ───────────────────────────────────────────
    /// Public-facing URL of THIS API server (e.g.
    /// `https://api.mattssoftware.com`). Used to build provider
    /// `redirect_uri`s plus the success deep-link template — must
    /// be the exact value registered with Google + Apple, otherwise
    /// they'll reject the auth request.
    pub public_url: Option<String>,
}
