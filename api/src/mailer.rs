//! Transactional email sender with two backends:
//!
//!   1. **Resend** — when `RESEND_API_KEY` + `RESEND_FROM` are set,
//!      we POST to https://api.resend.com/emails with a JSON body.
//!      No external SDK; just `reqwest`. Resend's free tier covers
//!      100 emails/day, which is plenty for password-reset volume.
//!
//!   2. **Tracing log fallback** — when Resend isn't configured (or a
//!      send fails) we emit a `tracing::warn!` with the rendered body
//!      so the URL still shows up in `journalctl -u fishbones-api`.
//!      The user / admin can copy it manually for testing or recovery.
//!      This means the password-reset flow works in dev / fresh
//!      installs without an extra DNS-verification step on Resend.
//!
//! The handler shouldn't care which backend ran. Both branches return
//! `Ok(())` so a network blip on Resend doesn't 500 the user-facing
//! request — we don't want a flaky external API to leak details to the
//! client (or to allow account-enumeration via "send error" vs "no such
//! email" differential timing). Real failures land in tracing for ops.

use std::sync::Arc;

#[derive(Clone)]
pub struct Mailer {
    /// Optional — when `None` we always fall through to the log
    /// backend. Cloning is cheap (`Arc`) so handlers can clone the
    /// mailer into a `tokio::spawn` if they ever want to fire-and-
    /// forget the send.
    inner: Arc<MailerInner>,
}

struct MailerInner {
    resend_api_key: Option<String>,
    /// `From:` address. Resend requires this to match a verified
    /// domain on the account. Common shape: `noreply@fishbones.academy`.
    from: Option<String>,
    /// Sender display name (`"Fishbones"` etc.). Optional — when
    /// missing the From header is just the bare email.
    from_name: Option<String>,
    /// Reused HTTP client. Resend's API doesn't keep long-lived
    /// connections so a fresh client per-process is fine; we share
    /// one to avoid the per-call connection-pool startup cost.
    http: reqwest::Client,
}

impl Mailer {
    /// Build a mailer from already-loaded env values. Returns a usable
    /// instance even when Resend isn't configured — the resulting
    /// mailer just always logs.
    pub fn from_env(
        resend_api_key: Option<String>,
        from: Option<String>,
        from_name: Option<String>,
    ) -> Self {
        Self {
            inner: Arc::new(MailerInner {
                resend_api_key,
                from,
                from_name,
                http: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(10))
                    .build()
                    .expect("build reqwest client"),
            }),
        }
    }

    /// `true` when Resend is fully configured (key + from address).
    /// Useful for log lines on boot — the `Mailer::send` path itself
    /// also checks this to decide whether to attempt a send.
    pub fn is_resend_configured(&self) -> bool {
        self.inner.resend_api_key.is_some() && self.inner.from.is_some()
    }

    /// Send a transactional email. Always returns `Ok(())` — failures
    /// are logged via `tracing` and the call never propagates an
    /// error up to the request handler. See module docs for why.
    pub async fn send(&self, to: &str, subject: &str, html_body: &str, text_body: &str) {
        if let (Some(api_key), Some(from)) = (
            self.inner.resend_api_key.as_deref(),
            self.inner.from.as_deref(),
        ) {
            // Resend's "from" supports either `email@host.tld` or
            // `Display Name <email@host.tld>`. We assemble the latter
            // when `from_name` is set so the recipient sees a proper
            // sender label.
            let from_header = match self.inner.from_name.as_deref() {
                Some(name) => format!("{name} <{from}>"),
                None => from.to_string(),
            };
            let body = serde_json::json!({
                "from": from_header,
                "to": [to],
                "subject": subject,
                "html": html_body,
                // Plain-text part for clients that prefer it (and to
                // dodge spam filters that score down html-only mail).
                "text": text_body,
            });
            let res = self
                .inner
                .http
                .post("https://api.resend.com/emails")
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await;
            match res {
                Ok(resp) if resp.status().is_success() => {
                    tracing::info!(
                        "[mailer] resend → {to}: '{subject}' (sent)"
                    );
                    return;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    tracing::error!(
                        "[mailer] resend → {to}: '{subject}' failed status={status} body={body}"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        "[mailer] resend → {to}: '{subject}' transport error: {e}"
                    );
                }
            }
            // Fall through to the log fallback so the URL is at least
            // recoverable from journalctl when Resend mis-fires.
        }

        // No Resend configured (or send failed). Log everything the
        // recipient would have seen so an admin can replay the flow.
        tracing::warn!(
            "[mailer:fallback] would send email — no Resend configured (or send failed)\n  to: {to}\n  subject: {subject}\n  text:\n{text_body}"
        );
    }
}
