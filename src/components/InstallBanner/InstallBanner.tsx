import { useEffect, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import { download as downloadIcon } from "@base/primitives/icon/icons/download";
import "@base/primitives/icon/icon.css";
import { downloadUrl, isWeb } from "../../lib/platform";
import "./InstallBanner.css";

/// Floating "get the desktop app" card mounted by App.tsx on the web
/// build. Slides in from the bottom-right ~3 seconds after first
/// interaction (or first render of the library — whichever comes
/// first), so it doesn't compete with the bootloader.
///
/// Dismissing writes a 30-day timestamp to localStorage; coming back
/// after that window re-shows the banner so a return visitor who's
/// been browsing for a month sees the upsell again. Permanent
/// "never show again" dismissal would feel hostile — keep the user
/// in control with the soft re-engage.
///
/// On the desktop build this component renders nothing — `isWeb`
/// gate at the top short-circuits any work.

const STORAGE_KEY = "fishbones:install-banner-dismissed-at";
/// Re-show after a month so return visitors see it again. Keeps the
/// upsell from going stale or feeling spammy.
const RESHOW_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/// Defer mounting so the banner doesn't compete with the bootloader
/// on first paint. Two seconds is enough for the courses list to
/// render and the user's eye to settle.
const SHOW_AFTER_MS = 2200;

export function InstallBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isWeb) return;
    // Honour a recent dismissal — but only for the configured window.
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const dismissedAt = parseInt(raw, 10);
        if (
          Number.isFinite(dismissedAt) &&
          Date.now() - dismissedAt < RESHOW_AFTER_MS
        ) {
          return;
        }
      }
    } catch {
      // localStorage may throw in private mode; just show the banner.
    }
    const t = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(t);
  }, []);

  if (!isWeb || !visible) return null;

  const { primary, all } = downloadUrl();
  const others = all.filter((t) => t.os !== primary.os);

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // Soft fail — the in-memory dismiss already hid the banner.
    }
  };

  return (
    <aside
      className="fishbones-install-banner"
      role="complementary"
      aria-label="Get the Fishbones desktop app"
    >
      <button
        type="button"
        className="fishbones-install-banner__close"
        onClick={dismiss}
        aria-label="Dismiss for 30 days"
      >
        <Icon icon={xIcon} size="xs" color="currentColor" />
      </button>
      <div className="fishbones-install-banner__title">
        Get the full Fishbones
      </div>
      <div className="fishbones-install-banner__body">
        Run Rust, Swift, C, C++, Java, Kotlin, C#, SvelteKit, and
        offline AI. Free + open source.
      </div>
      <div className="fishbones-install-banner__cta">
        <a
          href={primary.url}
          className="fishbones-install-banner__primary"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span aria-hidden>
            <Icon icon={downloadIcon} size="xs" color="currentColor" />
          </span>
          {primary.label}
        </a>
        <div className="fishbones-install-banner__alts">
          {others.map((t) => (
            <a
              key={t.os}
              href={t.url}
              className="fishbones-install-banner__alt"
              target="_blank"
              rel="noopener noreferrer"
            >
              {/* Single-word OS label so the row stays one line on
                  narrow viewports. */}
              {t.os === "macos"
                ? "macOS"
                : t.os === "windows"
                  ? "Windows"
                  : "Linux"}
            </a>
          ))}
        </div>
      </div>
    </aside>
  );
}
