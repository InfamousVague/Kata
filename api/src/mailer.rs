//! Transactional email sender with three backends, tried in order:
//!
//!   1. **SMTP** — when `SMTP_HOST` is set we hand the message off to
//!      a regular SMTP submission server. Common shapes:
//!        * `SMTP_HOST=localhost SMTP_PORT=25 SMTP_STARTTLS=false`
//!          → talk to the colocated Postfix on the VPS. Postfix is
//!          responsible for DKIM signing, queueing / retry, TLS to the
//!          recipient's mail server, etc. This is the self-hosted
//!          path; see api/setup-mail.sh for the install script.
//!        * `SMTP_HOST=smtp.mailgun.org SMTP_PORT=587 SMTP_USER=…
//!          SMTP_PASS=… SMTP_STARTTLS=true` → use a third-party
//!          SMTP relay. Same code path as local Postfix; the only
//!          knob that changes is whether STARTTLS is required.
//!
//!   2. **Resend** — when `RESEND_API_KEY` + `RESEND_FROM` are set
//!      and SMTP isn't, we POST to https://api.resend.com/emails.
//!      Useful as a no-mail-server fallback or for projects that
//!      don't want to babysit DKIM / DMARC.
//!
//!   3. **Tracing log fallback** — when neither is configured (or a
//!      send fails) we emit a `tracing::warn!` with the rendered body
//!      so the URL still shows up in `journalctl -u fishbones-api`.
//!      The user / admin can copy it manually for testing or recovery.
//!
//! The handler shouldn't care which backend ran. Every branch returns
//! `Ok(())` from `send` — a network blip on the SMTP / Resend path
//! shouldn't propagate a 5xx to the user (and would also let an
//! attacker time-attack "send error" vs "no such email" through the
//! anti-enumeration password-reset path). Real failures land in
//! tracing for ops.

use std::sync::Arc;

use lettre::message::{Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::Tls;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

#[derive(Clone)]
pub struct Mailer {
    /// Cloning is cheap (`Arc`) so handlers can clone the mailer into
    /// a `tokio::spawn` if they ever want to fire-and-forget a send.
    inner: Arc<MailerInner>,
}

struct MailerInner {
    /// Resolved SMTP transport when `SMTP_HOST` was set at boot. None
    /// disables the SMTP path; subsequent backends are tried.
    smtp: Option<SmtpBackend>,
    /// Resend API key + the `from` address. Kept separate from SMTP
    /// so a deploy can run with both configured (Resend as backup
    /// relay if the local Postfix is wedged, say) and we still pick
    /// SMTP first.
    resend_api_key: Option<String>,
    resend_from: Option<String>,
    resend_from_name: Option<String>,
    /// Reused HTTP client for the Resend path.
    http: reqwest::Client,
}

struct SmtpBackend {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    /// Parsed `From:` mailbox. Built once at boot from `SMTP_FROM`
    /// (+ optional `SMTP_FROM_NAME`) so every send reuses it without
    /// re-parsing.
    from: Mailbox,
}

impl Mailer {
    /// Build a mailer from already-loaded env values. Returns a usable
    /// instance even when neither SMTP nor Resend is configured —
    /// the resulting mailer just always logs.
    ///
    /// SMTP transport selection:
    ///   - `starttls = true` → `relay(host).port(port)` (lettre's
    ///     STARTTLS-required builder). Use this for any external
    ///     submission server (587 / 465).
    ///   - `starttls = false` → `builder_dangerous(host).port(port)`
    ///     (plaintext). Sane for `localhost:25` since the wire never
    ///     leaves loopback.
    /// Authentication is added when both `SMTP_USER` and `SMTP_PASS`
    /// are present — common for external relays, omitted for local
    /// Postfix which trusts the connecting host.
    pub fn from_env(
        smtp_host: Option<String>,
        smtp_port: Option<u16>,
        smtp_user: Option<String>,
        smtp_pass: Option<String>,
        smtp_from: Option<String>,
        smtp_from_name: Option<String>,
        smtp_starttls: bool,
        resend_api_key: Option<String>,
        resend_from: Option<String>,
        resend_from_name: Option<String>,
    ) -> Self {
        let smtp = match (smtp_host, smtp_from) {
            (Some(host), Some(from_addr)) => {
                let from_label = build_from_mailbox(&from_addr, smtp_from_name.as_deref());
                match from_label {
                    Some(from) => Some(build_smtp(
                        &host,
                        smtp_port,
                        smtp_user,
                        smtp_pass,
                        smtp_starttls,
                        from,
                    )),
                    None => {
                        tracing::error!(
                            "Mailer: SMTP_FROM='{from_addr}' isn't a valid email address — SMTP backend disabled."
                        );
                        None
                    }
                }
            }
            (Some(_), None) => {
                tracing::error!(
                    "Mailer: SMTP_HOST is set but SMTP_FROM isn't — set both to enable the SMTP backend."
                );
                None
            }
            _ => None,
        };

        Self {
            inner: Arc::new(MailerInner {
                smtp,
                resend_api_key,
                resend_from,
                resend_from_name,
                http: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(10))
                    .build()
                    .expect("build reqwest client"),
            }),
        }
    }

    /// `true` when the SMTP backend was successfully constructed at
    /// boot. Useful for one-line boot logs.
    pub fn is_smtp_configured(&self) -> bool {
        self.inner.smtp.is_some()
    }

    /// `true` when Resend is fully configured (key + from address).
    pub fn is_resend_configured(&self) -> bool {
        self.inner.resend_api_key.is_some() && self.inner.resend_from.is_some()
    }

    /// One-line description of which backend will handle the next
    /// `send` call. Returned for boot-log clarity.
    pub fn describe_active_backend(&self) -> &'static str {
        if self.is_smtp_configured() {
            "SMTP"
        } else if self.is_resend_configured() {
            "Resend"
        } else {
            "tracing log (fallback)"
        }
    }

    /// Send a transactional email. Always returns — failures are
    /// logged via `tracing` and never propagated. See module docs.
    pub async fn send(&self, to: &str, subject: &str, html_body: &str, text_body: &str) {
        // ── 1. SMTP ────────────────────────────────────────────
        if let Some(smtp) = self.inner.smtp.as_ref() {
            match build_lettre_message(&smtp.from, to, subject, html_body, text_body) {
                Ok(email) => match smtp.transport.send(email).await {
                    Ok(_) => {
                        tracing::info!("[mailer] smtp → {to}: '{subject}' (sent)");
                        return;
                    }
                    Err(e) => {
                        tracing::error!(
                            "[mailer] smtp → {to}: '{subject}' send error: {e}"
                        );
                        // Don't fall through to Resend on a transport
                        // error — if SMTP is configured the operator
                        // expects it to be the chosen path; quietly
                        // re-routing through Resend would mask a real
                        // outage. The tracing-log fallback below
                        // still captures the URL for recovery.
                    }
                },
                Err(e) => {
                    tracing::error!(
                        "[mailer] smtp → {to}: '{subject}' build error: {e}"
                    );
                }
            }
            // Fall through to log fallback (NOT Resend) — see comment.
            log_fallback(to, subject, text_body, "smtp send failed");
            return;
        }

        // ── 2. Resend ──────────────────────────────────────────
        if let (Some(api_key), Some(from)) = (
            self.inner.resend_api_key.as_deref(),
            self.inner.resend_from.as_deref(),
        ) {
            let from_header = match self.inner.resend_from_name.as_deref() {
                Some(name) => format!("{name} <{from}>"),
                None => from.to_string(),
            };
            let body = serde_json::json!({
                "from": from_header,
                "to": [to],
                "subject": subject,
                "html": html_body,
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
                    tracing::info!("[mailer] resend → {to}: '{subject}' (sent)");
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
            log_fallback(to, subject, text_body, "resend send failed");
            return;
        }

        // ── 3. Log fallback ────────────────────────────────────
        log_fallback(to, subject, text_body, "no SMTP / Resend configured");
    }
}

/// Helper: build a `Mailbox` from an email + optional display name.
/// Returns `None` if the email itself doesn't parse as an address —
/// the caller logs the misconfig and skips the SMTP backend.
fn build_from_mailbox(addr: &str, name: Option<&str>) -> Option<Mailbox> {
    let name_part = name.unwrap_or("").trim();
    let formatted = if name_part.is_empty() {
        addr.to_string()
    } else {
        format!("{} <{}>", name_part, addr)
    };
    formatted.parse().ok()
}

/// Build the lettre transport based on the env-supplied knobs. The
/// constructor variants bake in TLS / port defaults, so we apply the
/// caller's overrides last.
fn build_smtp(
    host: &str,
    port: Option<u16>,
    user: Option<String>,
    pass: Option<String>,
    starttls: bool,
    from: Mailbox,
) -> SmtpBackend {
    // `relay` requires STARTTLS by default (port 587 / 465).
    // `builder_dangerous` is plaintext by default (port 25 / 1025) —
    // sane only for localhost loopback or explicitly trusted networks.
    let mut builder = if starttls {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host)
            .expect("smtp relay builder")
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .tls(Tls::None)
    };
    if let Some(p) = port {
        builder = builder.port(p);
    }
    if let (Some(u), Some(p)) = (user, pass) {
        builder = builder.credentials(Credentials::new(u, p));
    }
    let transport = builder.build();
    SmtpBackend { transport, from }
}

/// Compose a Multipart-Alternative `Message` (HTML + plain-text)
/// suitable for either SMTP or any other transport that wants the
/// raw RFC5322 form. Returns `anyhow::Error` so address-parse and
/// message-build failures funnel into the same `tracing::error!` line
/// at the call site without the caller having to learn two error
/// hierarchies (lettre's `Error` for build, `AddressError` for parse).
fn build_lettre_message(
    from: &Mailbox,
    to: &str,
    subject: &str,
    html_body: &str,
    text_body: &str,
) -> anyhow::Result<Message> {
    let to_mailbox: Mailbox = to
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid recipient address {to:?}: {e}"))?;
    let body = MultiPart::alternative_plain_html(text_body.to_string(), html_body.to_string());
    Ok(Message::builder()
        .from(from.clone())
        .to(to_mailbox)
        .subject(subject)
        .multipart(body)?)
}

/// Always-available log fallback. Used when there's no configured
/// backend AND when a configured backend errors. Logged via
/// `tracing::warn!` so the URL is still recoverable from journalctl.
fn log_fallback(to: &str, subject: &str, text_body: &str, reason: &str) {
    tracing::warn!(
        "[mailer:fallback] would send email — {reason}\n  to: {to}\n  subject: {subject}\n  text:\n{text_body}"
    );
}
