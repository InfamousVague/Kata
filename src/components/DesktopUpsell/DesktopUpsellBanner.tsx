import { Icon } from "@base/primitives/icon";
import { download as downloadIcon } from "@base/primitives/icon/icons/download";
import { monitor } from "@base/primitives/icon/icons/monitor";
import "@base/primitives/icon/icon.css";
import { downloadUrl } from "../../lib/platform";
import "./DesktopUpsellBanner.css";

interface Props {
  /// Language id whose runtime needs the desktop app. Comes from
  /// `RunResult.desktopOnly.language` — anything our gate catches:
  /// c / cpp / java / kotlin / csharp / assembly / swift / sveltekit.
  language: string;
  /// One-line "why this needs the desktop app" line set by the gate.
  /// Pre-written per language inside `runtimes/index.ts`.
  reason: string;
}

/// Friendly display name for each language we gate. Drops the full
/// `languageLabel` import from Sidebar.tsx because we want the more
/// natural casing for marketing copy ("C++" not "c++", "C#" not
/// "csharp"). Falls back to the raw id if a new language ever lands
/// in the upsell path before we update the table.
const NAMES: Record<string, string> = {
  c: "C",
  cpp: "C++",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  assembly: "Assembly",
  swift: "Swift",
  sveltekit: "SvelteKit",
};

/// Rendered inside `OutputPane` when `RunResult.desktopOnly` is set.
/// Replaces the usual log / test rows with a calm explanation of why
/// the lesson can't run on web + a primary download button targeting
/// the user's detected OS.
///
/// The download URL is derived once at render time from
/// `platform.downloadUrl()`, which fingerprints the user agent. We
/// include a secondary "all platforms" link so the button isn't
/// load-bearing for users on an OS we mis-detected.
export function DesktopUpsellBanner({ language, reason }: Props) {
  const { primary, all } = downloadUrl();
  const niceName = NAMES[language] ?? language;

  return (
    <div className="fishbones-desktop-upsell">
      <div className="fishbones-desktop-upsell__head">
        <span className="fishbones-desktop-upsell__icon" aria-hidden>
          <Icon icon={monitor} size="sm" color="currentColor" />
        </span>
        <div className="fishbones-desktop-upsell__heading">
          <div className="fishbones-desktop-upsell__title">
            Run {niceName} on the desktop app
          </div>
          <div className="fishbones-desktop-upsell__reason">{reason}</div>
        </div>
      </div>

      <div className="fishbones-desktop-upsell__actions">
        <a className="fishbones-desktop-upsell__primary" href={primary.url}>
          <span aria-hidden>
            <Icon icon={downloadIcon} size="xs" color="currentColor" />
          </span>
          {primary.label}
        </a>
        <details className="fishbones-desktop-upsell__more">
          <summary>Other platforms</summary>
          <ul>
            {all
              .filter((t) => t.os !== primary.os)
              .map((t) => (
                <li key={t.os}>
                  <a href={t.url}>{t.label}</a>
                </li>
              ))}
          </ul>
        </details>
      </div>

      <div className="fishbones-desktop-upsell__foot">
        You can keep reading the lesson — only the Run button is
        gated on web.
      </div>
    </div>
  );
}
