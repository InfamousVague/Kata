import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@base/primitives/icon";
import { check } from "@base/primitives/icon/icons/check";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import { externalLink } from "@base/primitives/icon/icons/external-link";
import { copy as copyIcon } from "@base/primitives/icon/icons/copy";
import { refreshCw } from "@base/primitives/icon/icons/refresh-cw";
import "@base/primitives/icon/icon.css";
import type { RunResult } from "../../runtimes";
import ReactNativeDevTools from "./ReactNativeDevTools";
import MissingToolchainBanner from "../MissingToolchain/MissingToolchainBanner";
import { DesktopUpsellBanner } from "../DesktopUpsell/DesktopUpsellBanner";
import { useToolchainStatus } from "../../hooks/useToolchainStatus";
import "./OutputPane.css";

interface Props {
  result: RunResult | null;
  running: boolean;
  /// When true, skip the missing-toolchain banner + the raw-error card
  /// that would otherwise render when a run fails with a launch_error.
  /// The lesson view sets this once it's already showing a proactive
  /// toolchain banner above the workbench — without the flag the user
  /// would see the banner twice (above + below the editor) for the
  /// same underlying problem.
  suppressToolchainBanner?: boolean;
  /// Language of the current run. Drives the progressive-status labels
  /// shown under the spinner while `running` is true
  /// ("loading kotlin…" → "compiling…" → "running…" → "checking tests…").
  /// Omitted when we don't know it yet — the spinner falls back to a
  /// generic "running…".
  language?: string;
  /// Whether the current run expects test results. Adds a "checking
  /// tests…" label at the tail of the progress sequence so a slow test
  /// harness doesn't feel stuck on "running…".
  testsExpected?: boolean;
}

// Progress-label tuning. We don't have real phase events from the
// runtimes yet, so we fake them with time gates that roughly match
// each language's actual behaviour. Compiled languages earn a
// "compiling…" segment; interpreted ones skip straight to "running…"
// once the runtime has warmed up.
interface ProgressPhase {
  label: string;
  afterMs: number;
}
const COMPILED_LANGS = new Set([
  "rust",
  "go",
  "swift",
  "c",
  "cpp",
  "java",
  "kotlin",
  "assembly",
]);
function progressPhases(language?: string, testsExpected?: boolean): ProgressPhase[] {
  const langLabel = language ? languageLabel(language) : null;
  const isCompiled = language ? COMPILED_LANGS.has(language) : false;
  const phases: ProgressPhase[] = [
    { label: langLabel ? `loading ${langLabel}…` : "starting…", afterMs: 0 },
  ];
  if (isCompiled) {
    phases.push({ label: "compiling…", afterMs: 600 });
    phases.push({ label: "running…", afterMs: 4500 });
  } else {
    phases.push({ label: "running…", afterMs: 700 });
  }
  if (testsExpected) {
    phases.push({ label: "checking tests…", afterMs: isCompiled ? 7500 : 2500 });
  }
  return phases;
}
function languageLabel(id: string): string {
  switch (id) {
    case "javascript": return "JavaScript";
    case "typescript": return "TypeScript";
    case "python": return "Python";
    case "rust": return "Rust";
    case "go": return "Go";
    case "swift": return "Swift";
    case "c": return "C";
    case "cpp": return "C++";
    case "java": return "Java";
    case "kotlin": return "Kotlin";
    case "csharp": return "C#";
    case "assembly": return "Assembly";
    case "web": return "preview";
    case "threejs": return "Three.js";
    case "react": return "React";
    case "reactnative": return "React Native";
    default: return id;
  }
}

/// Bottom-right pane. Renders structured runtime output: captured
/// console logs, errors, and — when the lesson has hidden tests —
/// per-test pass/fail lines. Web-runtime results surface a "Preview"
/// card with the local URL + "Open in browser" / "Copy link" buttons;
/// the rendered page itself lives in the user's real browser so they
/// get DevTools + correct origin semantics.
export default function OutputPane({
  result,
  running,
  suppressToolchainBanner = false,
  language,
  testsExpected,
}: Props) {
  const passedCount = result?.tests?.filter((t) => t.passed).length ?? 0;
  const totalTests = result?.tests?.length ?? 0;
  const allPassed = totalTests > 0 && passedCount === totalTests && !result?.error;
  const previewUrl = result?.previewUrl;
  const previewKind = result?.previewKind;

  // When the native runner reports a missing toolchain (binary not on
  // PATH, or the macOS `java` stub bailing out to java.com), hit the
  // same `probe_language_toolchain` command the Playground uses — that
  // gives us the structured install hint the banner renders. The
  // `tcRefresh` counter re-runs the probe after a successful install,
  // which clears the banner and lets the learner click Run again.
  //
  // We intentionally DON'T gate on `toolchainStatus.installed === false`
  // here — the probe only checks "does the binary exist on PATH", and
  // for Kotlin/Java it'll cheerfully report installed=true when in
  // reality the stub can't run a program (no JDK). The actual run is
  // the authoritative signal: if `missingToolchainLanguage` came back,
  // the toolchain is broken in practice. We just need the install hint
  // from the probe to populate the banner's button.
  const [tcRefresh, setTcRefresh] = useState(0);
  const missingLang = result?.missingToolchainLanguage ?? null;
  const { status: toolchainStatus } = useToolchainStatus(
    missingLang ?? "",
    tcRefresh,
  );
  const showToolchainBanner =
    !suppressToolchainBanner &&
    !!missingLang &&
    !!toolchainStatus &&
    !!toolchainStatus.install_hint;

  // Progressive status label. We don't have real phase callbacks from
  // the runtimes, so we time-gate labels off a timer that starts the
  // moment `running` flips true. The phase table per language is
  // rough-tuned: compiled langs get an explicit "compiling…" segment,
  // interpreted ones skip straight to "running…" once the runtime has
  // warmed up.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 250);
    return () => window.clearInterval(id);
  }, [running]);
  const currentPhase = (() => {
    const phases = progressPhases(language, testsExpected);
    let chosen = phases[0];
    for (const p of phases) {
      if (elapsedMs >= p.afterMs) chosen = p;
    }
    return chosen;
  })();

  // Small copy-to-clipboard affordance on the URL card. We track the
  // "just copied" flash in local state so the button can briefly swap
  // to a check mark without needing a toast system.
  const [copied, setCopied] = useState(false);
  // Cache-busting key for the iframe: incremented each time a new
  // previewUrl result arrives so the iframe reloads even though the
  // URL is stable (the server swaps the HTML under the same URL).
  // The Refresh button also bumps this for manual reloads.
  const [reloadTick, setReloadTick] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Whenever the result flips to a new timestamp, reload the iframe
  // so the user sees the latest render without needing to reach for
  // the reload button manually. We key off durationMs as a cheap
  // "this is a new result" signal — it monotonically differs per run.
  useEffect(() => {
    if (previewUrl) setReloadTick((n) => n + 1);
  }, [previewUrl, result?.durationMs]);

  const openInBrowser = () => {
    if (!previewUrl) return;
    // tauri-plugin-opener is wired at the app level and is the only
    // reliable way to open an external URL from a Tauri webview. If we
    // end up running in the vite-dev web preview (no Tauri host), the
    // invoke rejects — fall back to window.open so the dev loop stays
    // usable.
    invoke("plugin:opener|open_url", { url: previewUrl }).catch(() => {
      try {
        window.open(previewUrl, "_blank", "noopener,noreferrer");
      } catch {
        /* nothing sensible to do */
      }
    });
  };

  const copyLink = async () => {
    if (!previewUrl) return;
    try {
      await navigator.clipboard.writeText(previewUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard write may fail without user-gesture permission — silent */
    }
  };

  return (
    <div className="fishbones-output">
      <div className="fishbones-output-header">
        <span className="fishbones-output-label">
          {previewUrl ? "preview" : "console"}
        </span>
        <div className="fishbones-output-header-right">
          {totalTests > 0 && !running && (
            <span
              className={`fishbones-output-tests-summary ${
                allPassed ? "fishbones-output-tests-summary--pass" : "fishbones-output-tests-summary--fail"
              }`}
            >
              {passedCount}/{totalTests} passed
            </span>
          )}
          {result && !running && (
            <span className="fishbones-output-duration">{result.durationMs.toFixed(0)}ms</span>
          )}
          {running && (
            <span className="fishbones-output-running-pill">
              <span className="fishbones-output-running-pill-dot" aria-hidden />
              {currentPhase.label}
            </span>
          )}
        </div>
      </div>

      <div className="fishbones-output-body">
        {!result && !running && (
          <div className="fishbones-output-empty">run your code to see output here</div>
        )}

        {running && (
          // Big centered spinner with the Fishbones fish-bone inside. The ring
          // spins via CSS `@keyframes fishbones-output-spin`; the fish itself is
          // theme-tinted (white on dark themes, black on light) via a
          // background-color + mask trick so we can keep one asset.
          <div className="fishbones-output-running" aria-live="polite">
            <div className="fishbones-output-running-stack" aria-hidden>
              <div className="fishbones-output-running-ring" />
              <div className="fishbones-output-running-logo" />
            </div>
            <div className="fishbones-output-running-label">{currentPhase.label}</div>
          </div>
        )}

        {/* Web-runtime preview. Two parts stacked: an in-app iframe
            window so the learner sees their render without leaving
            Fishbones, plus a URL card with "Open in browser" for when
            they want real DevTools. Both point at the same local
            tiny_http URL — the iframe just embeds it. */}
        {previewUrl && (
          <div className="fishbones-output-preview" role="status">
            <div
              className={`fishbones-output-preview-frame ${
                previewKind === "reactnative"
                  ? "fishbones-output-preview-frame--rn"
                  : ""
              }`}
            >
              <iframe
                ref={iframeRef}
                key={`${previewUrl}#${reloadTick}`}
                className={`fishbones-output-preview-iframe ${
                  previewKind === "reactnative"
                    ? "fishbones-output-preview-iframe--rn"
                    : ""
                }`}
                title="Rendered preview"
                src={previewUrl}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              />
            </div>
            <div className="fishbones-output-preview-head">
              <span className="fishbones-output-preview-label">Preview URL</span>
              <a
                className="fishbones-output-preview-link"
                href={previewUrl}
                onClick={(e) => {
                  e.preventDefault();
                  openInBrowser();
                }}
                title={previewUrl}
              >
                {previewUrl}
              </a>
            </div>
            <div className="fishbones-output-preview-actions">
              <button
                type="button"
                className="fishbones-output-preview-btn fishbones-output-preview-btn--primary"
                onClick={openInBrowser}
              >
                <Icon icon={externalLink} size="xs" color="currentColor" />
                <span>Open in browser</span>
              </button>
              <button
                type="button"
                className="fishbones-output-preview-btn"
                onClick={copyLink}
              >
                <Icon
                  icon={copied ? check : copyIcon}
                  size="xs"
                  color="currentColor"
                />
                <span>{copied ? "Copied" : "Copy link"}</span>
              </button>
              <button
                type="button"
                className="fishbones-output-preview-btn"
                onClick={() => setReloadTick((n) => n + 1)}
                title="Reload the in-app preview iframe"
              >
                <Icon icon={refreshCw} size="xs" color="currentColor" />
                <span>Reload</span>
              </button>
            </div>
            {previewKind === "reactnative" && (
              <ReactNativeDevTools previewUrl={previewUrl} />
            )}
          </div>
        )}

        {(result?.logs ?? []).map((line, i) => (
          <div key={`log-${i}`} className={`fishbones-output-line fishbones-output-line--${line.level}`}>
            {line.text}
          </div>
        ))}

        {result?.tests && result.tests.length > 0 && (
          <div className="fishbones-output-tests">
            {result.tests.map((t, i) => (
              <div
                key={`t-${i}`}
                className={`fishbones-output-test fishbones-output-test--${t.passed ? "pass" : "fail"}`}
              >
                <span className="fishbones-output-test-glyph">
                  <Icon
                    icon={t.passed ? check : xIcon}
                    size="xs"
                    color="currentColor"
                    weight="bold"
                  />
                </span>
                <span className="fishbones-output-test-name">{t.name}</span>
                {!t.passed && t.error && (
                  <pre className="fishbones-output-test-error">{t.error}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {result?.desktopOnly && (
          // Web build: this language's runtime needs the desktop app.
          // Render the upsell instead of logs / tests / errors. The
          // tests + logs arrays are empty in this case (the gate in
          // runtimes/index.ts returns a synthetic RunResult) so the
          // rest of the pane already renders nothing.
          <DesktopUpsellBanner
            language={result.desktopOnly.language}
            reason={result.desktopOnly.reason}
          />
        )}

        {showToolchainBanner && toolchainStatus && (
          // The run failed specifically because the toolchain isn't
          // installed — render the install-button banner in place of
          // the raw stderr dump so the learner has a one-click path
          // to "make this run work". The generic error block below
          // is suppressed in this case (its content is just the macOS
          // stub message, which the banner replaces with the actual
          // `brew install …` command).
          //
          // Force `installed: false` on the status we hand to the
          // banner. The probe reports `kotlinc` / `java` as installed
          // when the stubs exist on PATH, even though the actual
          // compile step we just ran failed because there's no JDK.
          // The run is the source of truth — the banner's own
          // "installed → don't render" guard must see what the run saw.
          <MissingToolchainBanner
            status={{ ...toolchainStatus, installed: false }}
            onInstalled={() => setTcRefresh((n) => n + 1)}
          />
        )}

        {result?.error && !showToolchainBanner && !(suppressToolchainBanner && missingLang) && (
          <div className="fishbones-output-error">
            <div className="fishbones-output-error-title">error</div>
            <pre>{result.error}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
