import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UseFishbonesCloud } from "../../hooks/useFishbonesCloud";
import "./SignInDialog.css";

/// Three-tab sign-in modal: email, Apple, Google. Used both by the
/// first-launch prompt and the Settings → Account section.
///
/// All three flows are optional — Fishbones works without an account
/// (local SQLite + JSON only). Signing in is purely additive: it
/// enables progress sync, course sharing, and cross-device pickup.
///
/// Apple + Google use the relay's browser-OAuth flow: clicking the
/// provider button opens the system browser via the `start_oauth`
/// Tauri command, the user signs in there, and the relay redirects
/// back to `fishbones://oauth/done?...`. App.tsx's deep-link
/// listener parses the callback and feeds the token to the cloud
/// hook, which materialises the signed-in user. We just need to
/// kick off the redirect and wait for `cloud.signedIn` to flip.

interface Props {
  cloud: UseFishbonesCloud;
  onClose: () => void;
  /// Optional copy variant. The first-launch prompt uses a softer
  /// "no account" CTA; the Settings entry hides it (the user is
  /// already inside the app and reached this dialog deliberately).
  showSkipButton?: boolean;
  /// Called when the user clicks "Skip / Maybe later".
  onSkip?: () => void;
  /// Optional headline override — first-launch wants a friendlier
  /// "welcome" pitch, Settings wants a plainer "sign in" one.
  headline?: string;
  blurb?: string;
}

type Tab = "email" | "apple" | "google";

/// Generate a URL-safe random session id. The relay uses this to
/// correlate the browser-side OAuth flow with the desktop callback,
/// but here we just need something opaque the server side will echo
/// back. 16 bytes of entropy is plenty for a one-shot correlation id.
function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64-url without padding — keeps the id ASCII-safe for the
  // backend's `[A-Za-z0-9_-]+` validator and avoids `=` characters
  // that would need URL-encoding.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default function SignInDialog({
  cloud,
  onClose,
  showSkipButton = false,
  onSkip,
  headline,
  blurb,
}: Props) {
  const [tab, setTab] = useState<Tab>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  /// Shown above the form when we auto-create an account on the user's
  /// behalf. Lets them know "you didn't have an account, we made one"
  /// without making them choose between Sign in and Create account up
  /// front. Cleared on the next submit.
  const [autoCreatedNotice, setAutoCreatedNotice] = useState(false);
  /// `true` once the user clicks "Continue with Apple/Google" and the
  /// system browser has been launched. We stay in this state until the
  /// deep-link callback fires and `cloud.signedIn` flips. If the user
  /// never finishes the flow, the dialog stays open with a "waiting"
  /// affordance — closing the modal cancels their attempt locally.
  const [awaitingOAuth, setAwaitingOAuth] = useState(false);
  /// Local error for the OAuth path — `cloud.error` only surfaces for
  /// the email + native id_token flows, but `start_oauth` can fail
  /// before the relay ever runs (provider mis-typed, browser open
  /// blocked, etc.).
  const [oauthError, setOauthError] = useState<string | null>(null);

  /// Single "Continue with email" submit. We hide the sign-in vs.
  /// create-account distinction from the user — under the hood we
  /// always try login first, and if the relay 401s we fall back to
  /// signup with the same credentials. The fallback covers two cases:
  ///
  ///   - email is brand new → login 401 → signup 200 → signed in.
  ///   - email is registered, password wrong → login 401 → signup 409
  ///     ("already exists") → we surface "Email or password didn't
  ///     match" to the user.
  ///
  /// This is safe because both paths require the user's password —
  /// nobody can take over an existing account this way; they just
  /// either log in or create an account on first contact.
  const onEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAutoCreatedNotice(false);
    try {
      await cloud.signInEmail(email, password);
      onClose();
      return;
    } catch (signInErr) {
      const msg =
        signInErr instanceof Error ? signInErr.message : String(signInErr);
      // The hook only collapses status codes into messages — anything
      // other than the 401 "didn't match" branch is a real failure
      // (server unreachable, 503 etc.) and we shouldn't auto-create.
      if (!msg.includes("didn't match")) {
        return;
      }
    }
    // Login 401 → either the account doesn't exist (auto-create) OR
    // the account exists with a different password (signup will 409,
    // we relay that as "didn't match").
    try {
      // No display_name yet — the user can set one in Settings →
      // Account once they're in. Keeping the modal small.
      await cloud.signUpEmail(email, password);
      setAutoCreatedNotice(true);
      onClose();
    } catch {
      /* signUpEmail surfaces its own error message via cloud.error,
         which the form already renders below the inputs. */
    }
  };

  /// Auto-close once the deep-link path lands and the user record
  /// materialises. Watching `signedIn` (rather than the raw token)
  /// means we wait for the `/me` fetch too — closing earlier could
  /// dump the user into a half-loaded state where `cloud.user` is
  /// still null.
  useEffect(() => {
    if (awaitingOAuth && cloud.signedIn) {
      onClose();
    }
  }, [awaitingOAuth, cloud.signedIn, onClose]);

  const startOAuth = async (provider: "apple" | "google") => {
    setOauthError(null);
    try {
      const sessionId = generateSessionId();
      await invoke("start_oauth", { provider, sessionId });
      setAwaitingOAuth(true);
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fishbones-signin-backdrop" onClick={onClose}>
      <div
        className="fishbones-signin-panel"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="fishbones-signin-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>

        <h2 className="fishbones-signin-title">
          {headline ?? "Sign in to Fishbones"}
        </h2>
        <p className="fishbones-signin-blurb">
          {blurb ??
            "Optional — sync progress between devices, upload courses, and share them with friends. You can also keep using Fishbones without an account; everything else still runs locally."}
        </p>

        <div className="fishbones-signin-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "email"}
            className={`fishbones-signin-tab ${tab === "email" ? "fishbones-signin-tab--active" : ""}`}
            onClick={() => setTab("email")}
          >
            Email
          </button>
          <button
            role="tab"
            aria-selected={tab === "apple"}
            className={`fishbones-signin-tab ${tab === "apple" ? "fishbones-signin-tab--active" : ""}`}
            onClick={() => setTab("apple")}
          >
            Apple
          </button>
          <button
            role="tab"
            aria-selected={tab === "google"}
            className={`fishbones-signin-tab ${tab === "google" ? "fishbones-signin-tab--active" : ""}`}
            onClick={() => setTab("google")}
          >
            Google
          </button>
        </div>

        {tab === "email" && (
          <form onSubmit={onEmailSubmit} className="fishbones-signin-form">
            <p className="fishbones-signin-helper">
              Enter your email and password — we'll sign you in if you
              have an account, or create one if you don't.
            </p>
            <label className="fishbones-signin-field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="fishbones-signin-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="current-password"
              />
              <small>At least 8 characters if creating a new account.</small>
            </label>
            {cloud.error && (
              <p className="fishbones-signin-error">{cloud.error}</p>
            )}
            {autoCreatedNotice && !cloud.error && (
              <p className="fishbones-signin-helper">
                Welcome! We created your account.
              </p>
            )}
            <button
              type="submit"
              className="fishbones-signin-primary"
              disabled={cloud.busy}
            >
              {cloud.busy ? "…" : "Continue with email"}
            </button>
          </form>
        )}

        {(tab === "apple" || tab === "google") && (
          <div className="fishbones-signin-oauth">
            <p className="fishbones-signin-helper">
              We'll open your browser to sign in with{" "}
              {tab === "apple" ? "Apple" : "Google"}, then bring you back here.
            </p>
            {tab === "apple" ? (
              <button
                type="button"
                className="fishbones-signin-oauth-btn fishbones-signin-oauth-btn--apple"
                onClick={() => void startOAuth("apple")}
                disabled={awaitingOAuth}
              >
                <span className="fishbones-signin-oauth-glyph" aria-hidden>
                  {/* Inline Apple silhouette. The earlier version used
                      the `` U+F8FF private-use codepoint, which only
                      renders when the cascaded font is an Apple system
                      face — under our `font: inherit` chain it fell
                      back to a font with no glyph for that codepoint
                      and the button label looked unbalanced. SVG is
                      what Apple's Sign-In branding guidelines actually
                      sanction for non-native buttons. */}
                  <svg
                    viewBox="0 0 18 18"
                    width="18"
                    height="18"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M14.94 9.97c-.02-2.05 1.68-3.04 1.76-3.09-.96-1.4-2.45-1.59-2.98-1.61-1.27-.13-2.48.74-3.13.74-.65 0-1.65-.72-2.71-.7-1.39.02-2.69.81-3.4 2.05-1.45 2.51-.37 6.22 1.04 8.27.69 1 1.51 2.13 2.58 2.09 1.04-.04 1.43-.67 2.69-.67 1.25 0 1.61.67 2.7.65 1.12-.02 1.83-1.02 2.51-2.03.79-1.16 1.12-2.29 1.14-2.35-.03-.01-2.18-.84-2.2-3.35M12.95 4.18c.57-.69.96-1.65.85-2.6-.82.03-1.81.55-2.4 1.24-.53.61-.99 1.59-.87 2.52.91.07 1.85-.46 2.42-1.16" />
                  </svg>
                </span>
                <span>Continue with Apple</span>
              </button>
            ) : (
              <button
                type="button"
                className="fishbones-signin-oauth-btn fishbones-signin-oauth-btn--google"
                onClick={() => void startOAuth("google")}
                disabled={awaitingOAuth}
              >
                <span className="fishbones-signin-oauth-glyph" aria-hidden>
                  <svg viewBox="0 0 18 18" width="18" height="18">
                    <path
                      fill="#4285F4"
                      d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                    />
                    <path
                      fill="#34A853"
                      d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                    />
                    <path
                      fill="#EA4335"
                      d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                    />
                  </svg>
                </span>
                <span>Continue with Google</span>
              </button>
            )}
            {awaitingOAuth && (
              <p className="fishbones-signin-oauth-waiting">
                Waiting for sign-in… finish in your browser, then we'll bring
                you back automatically.
              </p>
            )}
            {oauthError && (
              <p className="fishbones-signin-error">{oauthError}</p>
            )}
            {cloud.error && !oauthError && (
              <p className="fishbones-signin-error">{cloud.error}</p>
            )}
          </div>
        )}

        {showSkipButton && (
          <button
            type="button"
            className="fishbones-signin-skip"
            onClick={() => {
              onSkip?.();
              onClose();
            }}
          >
            Maybe later
          </button>
        )}
      </div>
    </div>
  );
}
