import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@base/primitives/icon";
import { check as checkIcon } from "@base/primitives/icon/icons/check";
import "@base/primitives/icon/icon.css";
import { THEMES, applyTheme, loadTheme, type ThemeName } from "../../theme/themes";
import type { UseFishbonesCloud } from "../../hooks/useFishbonesCloud";
import "./SettingsDialog.css";

interface Props {
  onDismiss: () => void;
  /// Cloud-sync hook instance (shared with App.tsx). Used to render
  /// the Account section. Required — SettingsDialog is only ever
  /// rendered inside App where `cloud` is in scope, so we don't
  /// bother making it optional.
  cloud: UseFishbonesCloud;
  /// Open the sign-in modal. Wired from App.tsx so the Account
  /// section can offer a "Sign in" CTA to signed-out users without
  /// each section having to know about the modal-state plumbing.
  onRequestSignIn: () => void;
}

interface Settings {
  anthropic_api_key: string | null;
  anthropic_model: string;
  openai_api_key: string | null;
}

type SectionId = "ai" | "theme" | "data" | "account";

interface SectionDef {
  id: SectionId;
  label: string;
  hint: string;
}

const BASE_SECTIONS: SectionDef[] = [
  { id: "ai", label: "AI & API", hint: "Anthropic key + model" },
  { id: "theme", label: "Theme", hint: "App + editor colors" },
  { id: "data", label: "Data", hint: "Caches + courses" },
];

const ACCOUNT_SECTION: SectionDef = {
  id: "account",
  label: "Account",
  hint: "Cloud sync · sign out",
};

const MODEL_OPTIONS: Array<{ id: string; label: string; hint: string }> = [
  {
    id: "claude-sonnet-4-5",
    label: "Sonnet 4.5 (balanced)",
    hint: "Default. ~$3 in / $15 out per 1M tokens. Great for most books.",
  },
  {
    id: "claude-opus-4-5",
    label: "Opus 4.5 (top quality)",
    hint: "~$15 in / $75 out per 1M tokens. ~5× cost, best pedagogy + test design.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5 (fastest)",
    hint: "~$1 in / $5 out per 1M tokens. Quick + cheap but weaker structured output.",
  },
];

/// Two-column settings dialog with a left-rail section nav and a right-side
/// scrollable pane. Keeps the panel at a bounded max-height so additional
/// sections never push the Save button off the screen.
export default function SettingsDialog({ onDismiss, cloud, onRequestSignIn }: Props) {
  const [section, setSection] = useState<SectionId>("ai");
  const [apiKey, setApiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [model, setModel] = useState<string>("claude-sonnet-4-5");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearingCourses, setClearingCourses] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [confirmClearCourses, setConfirmClearCourses] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => loadTheme());
  // Account-section state. `confirmDeleteAccount` follows the same
  // click-to-confirm pattern as `confirmClearCourses` above so the
  // destructive-action UX is consistent across the dialog.
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Account is always in the rail — when signed out the section
  // shows a sign-in CTA so the entry point is discoverable before
  // the learner has an account. The `hint` swaps out depending on
  // sign-in state to give the rail a useful summary either way.
  const sections = useMemo<SectionDef[]>(
    () => [
      ...BASE_SECTIONS,
      cloud.signedIn
        ? ACCOUNT_SECTION
        : { ...ACCOUNT_SECTION, hint: "Sign in to sync progress" },
    ],
    [cloud.signedIn],
  );

  // If the active section disappears (e.g. user signs out while the
  // dialog is open), fall back to the AI tab so we don't render a
  // dangling section pointer with no nav entry.
  useEffect(() => {
    if (!sections.find((s) => s.id === section)) {
      setSection("ai");
    }
  }, [sections, section]);

  function handleThemeChange(next: ThemeName) {
    setTheme(next);
    applyTheme(next);
  }

  useEffect(() => {
    invoke<Settings>("load_settings")
      .then((s) => {
        setApiKey(s.anthropic_api_key ?? "");
        setOpenaiKey(s.openai_api_key ?? "");
        if (s.anthropic_model) setModel(s.anthropic_model);
      })
      .catch(() => { /* not in tauri — ignore */ });
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await invoke("save_settings", {
        settings: {
          anthropic_api_key: apiKey.trim() || null,
          anthropic_model: model,
          openai_api_key: openaiKey.trim() || null,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearAllCourses() {
    setClearingCourses(true);
    setError(null);
    try {
      const entries = await invoke<Array<{ id: string }>>("list_courses");
      for (const e of entries) {
        await invoke("delete_course", { courseId: e.id });
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClearingCourses(false);
    }
  }

  async function clearIngestCache() {
    setClearingCache(true);
    setError(null);
    try {
      await invoke("cache_clear", { bookId: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearingCache(false);
    }
  }

  return (
    <div className="fishbones-settings-backdrop" onClick={onDismiss}>
      <div className="fishbones-settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="fishbones-settings-header">
          <span className="fishbones-settings-title">Settings</span>
          <button className="fishbones-settings-close" onClick={onDismiss}>×</button>
        </div>

        <div className="fishbones-settings-columns">
          <nav className="fishbones-settings-nav" aria-label="Settings sections">
            {sections.map((s) => (
              <button
                key={s.id}
                className={`fishbones-settings-nav-item ${
                  section === s.id ? "fishbones-settings-nav-item--active" : ""
                }`}
                onClick={() => setSection(s.id)}
              >
                <span className="fishbones-settings-nav-label">{s.label}</span>
                <span className="fishbones-settings-nav-hint">{s.hint}</span>
              </button>
            ))}
          </nav>

          <div className="fishbones-settings-body">
            {section === "ai" && (
              <section>
                <h3 className="fishbones-settings-section">AI-assisted ingest</h3>
                <p className="fishbones-settings-blurb">
                  Paste an Anthropic API key to enable Claude-powered structuring
                  when you import a book. Without a key, the import falls back to
                  the deterministic splitter (chapter/section breaks only).
                </p>
                <label className="fishbones-settings-field">
                  <span className="fishbones-settings-label">Anthropic API key</span>
                  <input
                    type="password"
                    className="fishbones-settings-input"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-ant-..."
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
                <p className="fishbones-settings-note">
                  Stored at <code>&lt;app_data_dir&gt;/settings.json</code>. Never
                  leaves your machine except in requests to api.anthropic.com.
                </p>

                <label className="fishbones-settings-field">
                  <span className="fishbones-settings-label">Model</span>
                  <div className="fishbones-settings-model-group">
                    {MODEL_OPTIONS.map((opt) => (
                      <label
                        key={opt.id}
                        className={`fishbones-settings-model ${model === opt.id ? "is-active" : ""}`}
                      >
                        <input
                          type="radio"
                          name="anthropic-model"
                          value={opt.id}
                          checked={model === opt.id}
                          onChange={() => setModel(opt.id)}
                        />
                        <div>
                          <div className="fishbones-settings-model-label">{opt.label}</div>
                          <div className="fishbones-settings-model-hint">{opt.hint}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </label>

                {/* Separate second provider for AI cover-art generation.
                    Anthropic doesn't ship image generation, so we use
                    OpenAI's gpt-image-1. Optional — without a key the
                    cover-art button in Course Settings surfaces a
                    friendly "add a key" message instead of crashing. */}
                <h3 className="fishbones-settings-section fishbones-settings-section--sub">
                  AI cover art
                </h3>
                <p className="fishbones-settings-blurb">
                  Optional. When set, a <strong>Generate artwork with AI</strong>{" "}
                  button appears in Course Settings → Appearance. Uses OpenAI's{" "}
                  <code>gpt-image-1</code> model (~$0.04 per cover) with a fixed
                  editorial style so every book in your library shares the same
                  visual language.
                </p>
                <label className="fishbones-settings-field">
                  <span className="fishbones-settings-label">OpenAI API key</span>
                  <input
                    type="password"
                    className="fishbones-settings-input"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    placeholder="sk-..."
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
                <p className="fishbones-settings-note">
                  Stored next to the Anthropic key in{" "}
                  <code>&lt;app_data_dir&gt;/settings.json</code>. Only used for
                  image requests to api.openai.com.
                </p>
              </section>
            )}

            {section === "theme" && (
              <section>
                <h3 className="fishbones-settings-section">Theme</h3>
                <p className="fishbones-settings-blurb">
                  Applied immediately. Preference is stored locally; it syncs with
                  your machine's light/dark setting only for the default Fishbones themes.
                </p>
                <div className="fishbones-settings-model-group fishbones-settings-model-group--scroll">
                  {THEMES.map((t) => (
                    <label
                      key={t.id}
                      className={`fishbones-settings-model ${theme === t.id ? "is-active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="fishbones-theme"
                        value={t.id}
                        checked={theme === t.id}
                        onChange={() => handleThemeChange(t.id)}
                      />
                      <div>
                        <div className="fishbones-settings-model-label">{t.label}</div>
                        <div className="fishbones-settings-model-hint">{t.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </section>
            )}

            {section === "data" && (
              <section>
                <h3 className="fishbones-settings-section">Data</h3>
                <p className="fishbones-settings-blurb">
                  Clears local content. Your API key and preferences stay.
                </p>
                <div className="fishbones-settings-data-row">
                  <div>
                    <div className="fishbones-settings-data-label">Ingest cache</div>
                    <div className="fishbones-settings-data-hint">
                      Clearing forces the next AI import to re-call Claude for every stage.
                    </div>
                  </div>
                  <button
                    className="fishbones-settings-danger"
                    onClick={clearIngestCache}
                    disabled={clearingCache}
                  >
                    {clearingCache ? "…" : "Clear cache"}
                  </button>
                </div>
                <div className="fishbones-settings-data-row">
                  <div>
                    <div className="fishbones-settings-data-label">All courses + progress</div>
                    <div className="fishbones-settings-data-hint">
                      Deletes every course from disk and resets lesson completion. Cannot be undone.
                    </div>
                  </div>
                  {confirmClearCourses ? (
                    <div className="fishbones-settings-confirm">
                      <button
                        className="fishbones-settings-secondary"
                        onClick={() => setConfirmClearCourses(false)}
                        disabled={clearingCourses}
                      >
                        Cancel
                      </button>
                      <button
                        className="fishbones-settings-danger"
                        onClick={clearAllCourses}
                        disabled={clearingCourses}
                      >
                        {clearingCourses ? "Clearing…" : "Really clear"}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="fishbones-settings-danger"
                      onClick={() => setConfirmClearCourses(true)}
                    >
                      Clear all courses
                    </button>
                  )}
                </div>
              </section>
            )}

            {section === "account" &&
              !(cloud.signedIn && typeof cloud.user === "object" && cloud.user) && (
                <section>
                  <h3 className="fishbones-settings-section">Account</h3>
                  <p className="fishbones-settings-blurb">
                    Sign in to sync progress, streaks, and lesson history
                    between devices, upload your imported books, and share
                    courses with friends. Fishbones works fully offline
                    without an account — signing in is purely additive.
                  </p>
                  <button
                    type="button"
                    className="fishbones-settings-primary"
                    onClick={() => {
                      onRequestSignIn();
                      onDismiss();
                    }}
                  >
                    Sign in
                  </button>
                </section>
              )}

            {section === "account" && cloud.signedIn && typeof cloud.user === "object" && cloud.user && (
              <AccountSection
                user={cloud.user}
                signingOut={signingOut}
                deletingAccount={deletingAccount}
                confirmDeleteAccount={confirmDeleteAccount}
                onSignOut={async () => {
                  setSigningOut(true);
                  setError(null);
                  try {
                    await cloud.signOut();
                    // Close the dialog so the user doesn't sit on an
                    // Account section that no longer applies. Defer one
                    // tick so React unmounts cleanly.
                    onDismiss();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setSigningOut(false);
                  }
                }}
                onRequestDeleteConfirm={() => setConfirmDeleteAccount(true)}
                onCancelDelete={() => setConfirmDeleteAccount(false)}
                onConfirmDelete={async () => {
                  setDeletingAccount(true);
                  setError(null);
                  try {
                    await cloud.deleteAccount();
                    onDismiss();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                    setConfirmDeleteAccount(false);
                  } finally {
                    setDeletingAccount(false);
                  }
                }}
              />
            )}

            {error && <div className="fishbones-settings-error">{error}</div>}
          </div>
        </div>

        {/* Footer sits outside the scroll body so the Save button is always
            visible regardless of section length. Only the AI section has a
            committable field; on other sections the Save button is hidden
            to avoid implying unsaved state. */}
        <div className="fishbones-settings-footer">
          {saved && (
            <span className="fishbones-settings-saved">
              <Icon icon={checkIcon} size="xs" color="currentColor" />
              saved
            </span>
          )}
          {section === "ai" && (
            <button
              className="fishbones-settings-primary"
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          )}
          {section !== "ai" && (
            <span className="fishbones-settings-footer-hint">
              Changes on this tab apply immediately.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/// Pick the most informative provider label for the signed-in account
/// row. Preference order is Apple → Google → email/password — Apple and
/// Google override an email password if both are linked, because in
/// practice if the learner used SIWA at any point, that's the
/// authoritative entry point they're likely to remember.
function describeAuthProvider(user: {
  apple_linked: boolean;
  google_linked: boolean;
  has_password: boolean;
}): string {
  if (user.apple_linked) return "Signed in via Apple";
  if (user.google_linked) return "Signed in via Google";
  if (user.has_password) return "Signed in with email";
  return "Signed in";
}

interface AccountSectionProps {
  user: {
    id: string;
    email: string | null;
    display_name: string | null;
    has_password: boolean;
    apple_linked: boolean;
    google_linked: boolean;
  };
  signingOut: boolean;
  deletingAccount: boolean;
  confirmDeleteAccount: boolean;
  onSignOut: () => void;
  onRequestDeleteConfirm: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

/// Account/Profile section. Rendered only when signed in. Surfaces the
/// learner's identity (display name + email + provider), a sign-out
/// button, and a click-to-confirm delete-account flow that mirrors the
/// destructive-action UX used by `confirmClearCourses` above.
function AccountSection({
  user,
  signingOut,
  deletingAccount,
  confirmDeleteAccount,
  onSignOut,
  onRequestDeleteConfirm,
  onCancelDelete,
  onConfirmDelete,
}: AccountSectionProps) {
  const displayName = user.display_name?.trim() || null;
  // Avatar initial — first character of the display name, falling back
  // to the email's local part. Always uppercase for visual consistency.
  // If neither is available we fall through to a generic person glyph.
  const initialSource = displayName || user.email || "";
  const initial = initialSource ? initialSource.charAt(0).toUpperCase() : "?";
  const providerLabel = describeAuthProvider(user);

  return (
    <section>
      <h3 className="fishbones-settings-section">Account</h3>
      <p className="fishbones-settings-blurb">
        Your Fishbones cloud account. Lesson progress syncs across
        devices when signed in; nothing is uploaded otherwise.
      </p>

      <div className="fishbones-settings-account-card">
        <div className="fishbones-settings-account-avatar" aria-hidden>
          {initial}
        </div>
        <div className="fishbones-settings-account-meta">
          <div className="fishbones-settings-account-name">
            {displayName || user.email || "Signed in"}
          </div>
          {user.email && displayName && (
            <div className="fishbones-settings-account-email">{user.email}</div>
          )}
          <div className="fishbones-settings-account-provider">
            {providerLabel}
          </div>
        </div>
      </div>

      <div className="fishbones-settings-data-row">
        <div>
          <div className="fishbones-settings-data-label">Sign out</div>
          <div className="fishbones-settings-data-hint">
            Removes the cloud token from this device. Your local courses
            and progress stay; you can sign back in any time.
          </div>
        </div>
        <button
          className="fishbones-settings-secondary"
          onClick={onSignOut}
          disabled={signingOut || deletingAccount}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>

      <div className="fishbones-settings-data-row">
        <div>
          <div className="fishbones-settings-data-label">Delete account</div>
          <div className="fishbones-settings-data-hint">
            Permanently deletes your Fishbones cloud account, all synced
            progress, and any uploaded courses. Local files on this
            device are not affected. Cannot be undone.
          </div>
        </div>
        {confirmDeleteAccount ? (
          <div className="fishbones-settings-confirm">
            <button
              className="fishbones-settings-secondary"
              onClick={onCancelDelete}
              disabled={deletingAccount}
            >
              Cancel
            </button>
            <button
              className="fishbones-settings-danger"
              onClick={onConfirmDelete}
              disabled={deletingAccount}
            >
              {deletingAccount ? "Deleting…" : "Really delete"}
            </button>
          </div>
        ) : (
          <button
            className="fishbones-settings-danger"
            onClick={onRequestDeleteConfirm}
            disabled={signingOut}
          >
            Delete account
          </button>
        )}
      </div>
    </section>
  );
}
