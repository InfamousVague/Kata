import { useEffect, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { code as codeIcon } from "@base/primitives/icon/icons/code";
import { eye } from "@base/primitives/icon/icons/eye";
import { columns2 } from "@base/primitives/icon/icons/columns-2";
import { smartphone } from "@base/primitives/icon/icons/smartphone";
import "@base/primitives/icon/icon.css";
import type { LanguageId } from "../../data/types";
import { usePlaygroundFiles } from "../../hooks/usePlaygroundFiles";
import { useToolchainStatus } from "../../hooks/useToolchainStatus";
import { runFiles, isPassing, type RunResult } from "../../runtimes";
import EditorPane from "../Editor/EditorPane";
import OutputPane from "../Output/OutputPane";
import PhoneToggleButton from "../FloatingPhone/PhoneToggleButton";
import {
  openPhonePopout,
  closePhonePopout,
  makePhonePreviewBus,
} from "../../lib/phonePopout";
import Workbench from "../Workbench/Workbench";
import MissingToolchainBanner from "../MissingToolchain/MissingToolchainBanner";
import "./PlaygroundView.css";

/// Fire a `fishbones:ask-ai` event the way LessonReader / QuizView do.
/// AiAssistant is mounted at the app root and listens window-wide, so a
/// plain CustomEvent is enough plumbing — no prop drilling required.
function askAi(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent("fishbones:ask-ai", { detail }));
}

/// Cheap heuristic: does this JavaScript snippet touch the DOM? The
/// in-browser JS sandbox has no `document` / `window` so any of these
/// patterns will throw on Run. Used by the apply-code handler to auto-
/// route DOM-using output into the Web runtime instead.
function looksLikeDomCode(code: string): boolean {
  return /\b(?:document\.|window\.|addEventListener\s*\(|querySelector|getElementById)\b/.test(
    code,
  );
}

/// Pull every string ID the snippet references from `getElementById('x')`
/// or `querySelector('#x')` so we can synthesize matching HTML elements.
/// Falls back to a small default set when nothing matches — better to
/// over-render a couple of placeholders than to leave the script with
/// no targets.
function referencedDomIds(code: string): string[] {
  const ids = new Set<string>();
  const byIdRe = /getElementById\s*\(\s*['"]([\w-]+)['"]\s*\)/g;
  const querySelectorIdRe = /querySelector(?:All)?\s*\(\s*['"]#([\w-]+)['"]\s*\)/g;
  for (const m of code.matchAll(byIdRe)) ids.add(m[1]);
  for (const m of code.matchAll(querySelectorIdRe)) ids.add(m[1]);
  if (ids.size === 0) ids.add("app");
  return [...ids];
}

/// Build a minimal `index.html` that wires every referenced ID. We
/// guess element type from the id text (`btn`/`button` → `<button>`;
/// `input`/`field` → `<input>`; everything else → `<div>`). The button
/// gets a sensible default label so the rendered page isn't blank
/// before the script has a chance to populate it.
function buildHtmlScaffold(ids: string[]): string {
  const body = ids
    .map((id) => {
      const lower = id.toLowerCase();
      // Words that commonly name a clickable element. We don't have
      // any deeper signal than the id text, so any "verb-y" /
      // "interactable" id ends up as a button — better than rendering
      // a silent div the script's `addEventListener('click')` never
      // fires on.
      if (
        /\b(?:btn|button|click|toggle|submit|trigger|counter|count|action)\b/.test(
          lower,
        )
      ) {
        return `    <button id="${id}">Click me</button>`;
      }
      if (lower.includes("input") || lower.includes("field")) {
        return `    <input id="${id}" />`;
      }
      return `    <div id="${id}"></div>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Fishbones Playground</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
${body}
  </main>
  <script src="script.js"></script>
</body>
</html>
`;
}

/// Languages the playground offers. The roster matches LanguageId —
/// the picker shows every supported runtime so a user can try anything
/// without hunting for it. Web + Three.js are multi-file templates
/// (HTML + CSS + JS); their starter content lives in `playgroundTemplates.ts`.
const LANGUAGE_OPTIONS: Array<{ id: LanguageId; label: string }> = [
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "swift", label: "Swift" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "java", label: "Java" },
  { id: "kotlin", label: "Kotlin" },
  { id: "csharp", label: "C#" },
  { id: "assembly", label: "Assembly" },
  { id: "web", label: "Web (HTML + CSS + JS)" },
  { id: "threejs", label: "Three.js" },
  { id: "react", label: "React (JSX + CSS)" },
  { id: "reactnative", label: "React Native" },
  { id: "svelte", label: "Svelte 5" },
  { id: "solid", label: "SolidJS" },
  { id: "htmx", label: "HTMX" },
  { id: "astro", label: "Astro" },
  { id: "bun", label: "Bun" },
  { id: "tauri", label: "Tauri (Rust)" },
  { id: "solidity", label: "Solidity" },
];

/// View layout options for the workbench. `split` (editor + output
/// side by side) is the default; `editor` collapses the output entirely
/// for focused code time; `preview` collapses the editor so the URL
/// card / console fills the pane (useful for reading a long stack
/// trace or stacking the URL card front-and-center). `phone` wraps the
/// output pane in an iPhone-shaped chrome (PhoneFrame) — only available
/// for the React Native and Swift languages, where a device frame is
/// the right mental model.
type ViewMode = "split" | "editor" | "preview" | "phone";

const VIEW_MODE_OPTIONS: Array<{ id: ViewMode; label: string; icon: string }> = [
  { id: "split", label: "Split", icon: columns2 },
  { id: "editor", label: "Editor", icon: codeIcon },
  { id: "preview", label: "Output", icon: eye },
  { id: "phone", label: "Phone", icon: smartphone },
];

/// Languages where the "Phone simulator" view mode makes sense. Other
/// languages drop the option entirely from the segmented control — a
/// terminal language being shown inside a device frame is more
/// confusing than helpful.
const PHONE_VIEW_LANGUAGES = new Set<LanguageId>(["reactnative", "swift"]);

/// jsfiddle-style free-form coding sandbox. No lesson prose, no "mark
/// complete" — just a language picker, editor, and output pane. Code
/// persists per-language in localStorage (see usePlaygroundFiles) so
/// switching Rust → Go → Rust restores what you were working on.
export default function PlaygroundView() {
  const { language, setLanguage, files, setFiles, resetToTemplate } =
    usePlaygroundFiles("javascript");
  const [activeFileIdx, setActiveFileIdx] = useState(0);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  /// Bumped after a successful toolchain install so the probe re-runs
  /// and the banner can disappear. Kept here instead of inside the hook
  /// so the Run button can also trigger a re-probe after a `launch_error`
  /// surfaces a missing tool mid-session.
  const [tcRefresh, setTcRefresh] = useState(0);
  const { status: toolchainStatus } = useToolchainStatus(language, tcRefresh);
  // Default to split — editor + output side-by-side so run results appear
  // immediately without the learner having to switch views.
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  // Floating phone preference: remembered in localStorage so the
  // user's "I want the popout" intent sticks across reloads. Only
  // meaningful when the active language can show a phone simulator
  // (RN / Swift); for everything else neither the popout nor the
  // toggle is rendered.
  const [floatingPhoneOpen, setFloatingPhoneOpen] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return true;
    const v = localStorage.getItem("fishbones:floating-phone-open");
    if (v === null) return true;
    return v === "true";
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      "fishbones:floating-phone-open",
      floatingPhoneOpen ? "true" : "false",
    );
  }, [floatingPhoneOpen]);

  // Phone popout scope keyed on the active language so RN and Swift
  // each have their own popout window + bus channel — a learner can
  // flip between languages without one popout's content overwriting
  // the other.
  const phoneScope = `playground:${language}`;
  const phoneBus = PHONE_VIEW_LANGUAGES.has(language)
    ? makePhonePreviewBus(phoneScope)
    : null;
  // Close the popout when the user navigates away from a phone-
  // eligible language so we don't leave a stale RN simulator open
  // while they're editing Python. We re-open on the next Run for
  // the new language anyway.
  useEffect(() => {
    return () => {
      if (PHONE_VIEW_LANGUAGES.has(language)) {
        void closePhonePopout(phoneScope);
      }
    };
  }, [language, phoneScope]);

  // Auto-flip the view mode when the user switches to / away from a
  // phone-friendly language. Two distinct nudges:
  //   1. Picking RN/Swift while still on the default `split` view →
  //      jump straight into `phone` so the chrome is visible without
  //      having to discover the segmented control.
  //   2. Picking a non-phone language while in `phone` → fall back to
  //      `split` because the phone option gets hidden underneath them
  //      and we'd otherwise leave the user staring at an empty pane.
  // Once the user manually picks a different mode after a language
  // change, we stop nudging — the effect's dependencies only fire on
  // language transitions so a manual `setViewMode("split")` while on
  // RN sticks.
  useEffect(() => {
    if (PHONE_VIEW_LANGUAGES.has(language)) {
      if (viewMode === "split") setViewMode("phone");
    } else {
      if (viewMode === "phone") setViewMode("split");
    }
    // Intentionally only depend on `language` — we don't want to
    // re-fire when the user manually flips the view mode, only when
    // the language transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Filter the segmented-control options so the "Phone" pill only
  // appears when the active language can use it. Avoids a dead pill
  // for Python / Rust / etc.
  const visibleViewModeOptions = VIEW_MODE_OPTIONS.filter(
    (opt) => opt.id !== "phone" || PHONE_VIEW_LANGUAGES.has(language),
  );

  const showEditor = viewMode !== "preview";
  const showOutput = viewMode !== "editor";
  // Phone-eligible language in either `phone` or `split` view → render
  // the floating-phone modal over a full-width editor instead of the
  // old fixed right-pane phone stage. `editor` / `preview` view modes
  // are explicit user requests to hide the simulator, so we don't
  // override them by floating one in.
  const useFloatingPhone =
    PHONE_VIEW_LANGUAGES.has(language) &&
    (viewMode === "phone" || viewMode === "split");

  // "Generate from a prompt" mini-form. Toggled by the Generate button
  // in the header; closes itself after submit. We keep the input local
  // here (rather than punting to the chat panel) so the learner stays
  // in the playground's mental model — type the request, get the code,
  // paste it back into the editor.
  const [genOpen, setGenOpen] = useState(false);
  const [genText, setGenText] = useState("");

  // Pending DOM-route: when the apply-code handler decides a JS snippet
  // should run as a Web app, it stashes the html/js payload here and
  // calls setLanguage("web"). A separate effect waits for the language
  // to actually flip (so usePlaygroundFiles has seeded the web template
  // into `files`), then patches index.html + script.js. Doing this with
  // setTimeout raced React state and wrote to the wrong language's
  // storage; the effect-based queue is deterministic.
  const [pendingDomRoute, setPendingDomRoute] = useState<
    { html: string; script: string } | null
  >(null);
  useEffect(() => {
    if (!pendingDomRoute) return;
    if (language !== "web") return;
    setFiles((prev) => {
      if (prev.length === 0) return prev;
      return prev.map((f) => {
        if (f.name === "index.html") return { ...f, content: pendingDomRoute.html };
        if (f.name === "script.js") return { ...f, content: pendingDomRoute.script };
        return f;
      });
    });
    setActiveFileIdx(0);
    setPendingDomRoute(null);
  }, [pendingDomRoute, language, setFiles]);

  function currentSource(): string {
    return files
      .map((f) => (files.length > 1 ? `// ${f.name}\n${f.content}` : f.content))
      .join("\n\n");
  }

  function handleExplain() {
    const code = currentSource().trim();
    if (!code) return;
    askAi({ kind: "explain-step", language, code });
  }

  function handleGenerateSubmit(e: React.FormEvent) {
    e.preventDefault();
    const request = genText.trim();
    if (!request) return;
    askAi({ kind: "generate-code", language, request });
    setGenText("");
    setGenOpen(false);
  }

  // Listen for the AI's `fishbones:apply-code` event — fired by
  // AiAssistant once a generate-code request finishes streaming.
  // Replace the active editor file's contents with the generated
  // source (the model is prompted to emit a single self-contained
  // block, so a wholesale swap is correct). Ignore events whose
  // language doesn't match the active language so a generate-code
  // dispatched from a different surface (lesson editor, popped
  // workbench) doesn't stomp the playground.
  //
  // Special case: when the model returns DOM-using JavaScript
  // (`document.getElementById`, `addEventListener`, etc.) for the
  // plain JS sandbox — which has no DOM and would throw at runtime —
  // auto-route to the Web playground instead. We synthesize a minimal
  // HTML scaffold containing every `id="..."` the JS references and
  // drop the generated code into `script.js`. The result: "make me a
  // counter button" produces a working preview without the learner
  // having to know they should have picked Web.
  useEffect(() => {
    const handler = (ev: Event) => {
      const ce = ev as CustomEvent<{ language?: string; code: string }>;
      const detail = ce.detail;
      if (!detail || !detail.code) return;
      if (detail.language && detail.language !== language) return;
      const usesDom =
        (language === "javascript" || language === "typescript") &&
        looksLikeDomCode(detail.code);
      if (usesDom) {
        const ids = referencedDomIds(detail.code);
        const html = buildHtmlScaffold(ids);
        // Queue the patch and flip the language. The effect above
        // applies the patch once the language transition has committed
        // and `files` has been re-seeded with the web template.
        setPendingDomRoute({ html, script: detail.code });
        setLanguage("web");
        setResult(null);
        return;
      }
      setFiles((prev) => {
        if (prev.length === 0) return prev;
        const idx = Math.max(0, Math.min(activeFileIdx, prev.length - 1));
        const copy = prev.slice();
        copy[idx] = { ...copy[idx], content: detail.code };
        return copy;
      });
      setResult(null);
    };
    window.addEventListener("fishbones:apply-code", handler);
    return () => window.removeEventListener("fishbones:apply-code", handler);
  }, [language, activeFileIdx, setFiles, setLanguage]);

  async function handleRun() {
    // Pre-run safety net: if the active JS / TS file uses DOM APIs but
    // the language is set to plain JavaScript / TypeScript (the no-DOM
    // sandbox), auto-route to the Web runtime first. This catches the
    // case where the AI dropped code into the editor before our
    // apply-code auto-route landed, OR the learner pasted DOM code by
    // hand. We bail out of the run after queuing the route — the
    // language-transition effect rebuilds files + the user clicks Run
    // again on the now-correct surface.
    if (language === "javascript" || language === "typescript") {
      const source = files.map((f) => f.content).join("\n");
      if (looksLikeDomCode(source)) {
        const ids = referencedDomIds(source);
        const html = buildHtmlScaffold(ids);
        setPendingDomRoute({ html, script: source });
        setLanguage("web");
        setResult(null);
        return;
      }
    }
    setRunning(true);
    setResult(null);
    // Auto-pop the phone simulator open on every Run for a phone-
    // eligible language. The popout window opens (or focuses, if
    // already open); we also push a `running` marker so the popout
    // shows a "running…" placeholder while the runtime works.
    if (PHONE_VIEW_LANGUAGES.has(language)) {
      setFloatingPhoneOpen(true);
      void openPhonePopout(phoneScope, `Playground · ${language}`);
      phoneBus?.emit({ type: "running" });
    }
    try {
      const r = await runFiles(language, files);
      if (!r) {
        const msg = `No runtime for language "${language}".`;
        setResult({
          logs: [],
          error: msg,
          durationMs: 0,
        });
        if (PHONE_VIEW_LANGUAGES.has(language)) {
          phoneBus?.emit({ type: "console", logs: [], error: msg });
        }
        return;
      }
      setResult(r);
      // Push the run outcome to the popped phone simulator. RN's
      // self-hosted preview URL drives an iframe in the popout;
      // Swift (and any RN run that didn't yield a previewUrl)
      // renders its captured stdout/stderr in a console panel.
      if (PHONE_VIEW_LANGUAGES.has(language)) {
        if (language === "reactnative" && r.previewUrl) {
          phoneBus?.emit({ type: "preview", url: r.previewUrl });
        } else {
          phoneBus?.emit({
            type: "console",
            logs: r.logs ?? [],
            error: r.error,
          });
        }
      }
      void isPassing; // silence unused import — the helper is part of
      // the public runtimes surface, we just don't need it for the
      // no-tests playground path.
    } catch (e) {
      const errMsg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      setResult({
        logs: [],
        error: errMsg,
        durationMs: 0,
      });
      if (PHONE_VIEW_LANGUAGES.has(language)) {
        phoneBus?.emit({ type: "console", logs: [], error: errMsg });
      }
    } finally {
      setRunning(false);
    }
  }

  function handleFileChange(index: number, next: string) {
    setFiles((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const copy = prev.slice();
      copy[index] = { ...copy[index], content: next };
      return copy;
    });
  }

  function handleLanguageChange(next: LanguageId) {
    setActiveFileIdx(0);
    setResult(null);
    setLanguage(next);
  }

  const editorNode = (
    <EditorPane
      language={language}
      files={files}
      activeIndex={activeFileIdx}
      onActiveIndexChange={setActiveFileIdx}
      onChange={handleFileChange}
      onRun={handleRun}
      onReset={resetToTemplate}
    />
  );
  const outputNode = (
    <OutputPane result={result} running={running} language={language} />
  );

  // Build the body of the phone "screen" based on the active language.
  // RN gets the live preview iframe (same URL the OutputPane card opens
  // externally — embedded inline here so it reads as a device render);
  // Swift gets a console-style log dump because the Swift runner only
  // emits stdout/stderr. Anything else (the language picker is gated
  // upstream so this is defensive) shows a placeholder.
  return (
    <div className="fishbones-playground">
      {/* Header: language picker on the left, view toggle on the right. */}
      <div className="fishbones-playground-header">
        <label className="fishbones-playground-lang-picker">
          <span className="fishbones-playground-lang-label">Language</span>
          <select
            className="fishbones-playground-lang-select"
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value as LanguageId)}
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <div className="fishbones-playground-spacer" />

        {/* AI helpers — Explain (walks through current editor source
            step-by-step) and Generate (opens an inline prompt where
            the learner describes what they want and the assistant
            emits code in the active language). Both round-trip
            through the existing `fishbones:ask-ai` event bus that
            LessonReader / QuizView already use. */}
        <div className="fishbones-playground-ai" role="group" aria-label="AI helpers">
          <button
            type="button"
            className="fishbones-playground-ai-btn"
            onClick={handleExplain}
            disabled={currentSource().trim().length === 0}
            title="Walk through the editor's code step by step"
          >
            Explain
          </button>
          <button
            type="button"
            className={`fishbones-playground-ai-btn ${
              genOpen ? "fishbones-playground-ai-btn--active" : ""
            }`}
            onClick={() => setGenOpen((v) => !v)}
            aria-expanded={genOpen}
            title="Describe what you want and have the assistant write it"
          >
            Generate
          </button>
        </div>

        <div
          className="fishbones-playground-seg"
          role="group"
          aria-label="View mode"
        >
          {visibleViewModeOptions.map((opt) => {
            const active = viewMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={`fishbones-playground-seg-btn ${
                  active ? "fishbones-playground-seg-btn--active" : ""
                }`}
                onClick={() => setViewMode(opt.id)}
                title={opt.label}
                aria-pressed={active}
              >
                <Icon icon={opt.icon} size="xs" color="currentColor" />
                <span className="fishbones-playground-seg-label">
                  {opt.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Generate-from-prompt strip. Slides in under the header when
          the learner toggles the "Generate" button — input on the
          left, send on the right, Esc dismisses. Submit dispatches a
          `fishbones:ask-ai` event with `kind: "generate-code"` and
          the AiAssistant takes it from there. */}
      {genOpen && (
        <form
          className="fishbones-playground-generate"
          onSubmit={handleGenerateSubmit}
        >
          <input
            type="text"
            autoFocus
            className="fishbones-playground-generate-input"
            placeholder={`Describe what you want in ${language}…`}
            value={genText}
            onChange={(e) => setGenText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setGenText("");
                setGenOpen(false);
              }
            }}
          />
          <button
            type="submit"
            className="fishbones-playground-generate-submit"
            disabled={genText.trim().length === 0}
          >
            Generate
          </button>
          <button
            type="button"
            className="fishbones-playground-generate-cancel"
            onClick={() => {
              setGenText("");
              setGenOpen(false);
            }}
            aria-label="Cancel"
          >
            ×
          </button>
        </form>
      )}

      {/* Missing-toolchain banner. Only rendered when the Rust probe
          returned installed=false AND the recipe has an install hint
          (i.e. we know how to fix it). Sits above the workbench so it's
          the first thing the learner sees if they just picked Kotlin and
          don't have it yet. Bumping `tcRefresh` after a successful install
          re-runs the probe and clears the banner. */}
      {toolchainStatus &&
        !toolchainStatus.installed &&
        toolchainStatus.install_hint && (
          <MissingToolchainBanner
            status={toolchainStatus}
            onInstalled={() => setTcRefresh((n) => n + 1)}
          />
        )}

      <div className="fishbones-playground-workbench">
        {useFloatingPhone ? (
          // Floating-phone path: the editor takes the full pane width
          // and the phone simulator overlays as a draggable modal
          // (rendered below at the playground root). This replaces
          // the old fixed right-pane phone stage for `phone` + `split`
          // views on RN/Swift. `outputNode` isn't shown here because
          // the floating phone IS the output surface — the user can
          // still flip viewMode to `preview` to get the textual
          // logs/error pane.
          <div className="fishbones-playground-solo">{editorNode}</div>
        ) : showEditor && showOutput ? (
          // Classic split — the Workbench card gives us the resize handle
          // and matches what courses use so switching between the two
          // doesn't rearrange muscle memory.
          <Workbench
            storageKey="kata:playground-workbench-split"
            fillWidth
            editor={editorNode}
            output={outputNode}
          />
        ) : showEditor ? (
          // Editor-only: same card chrome as the workbench but without
          // the second column.
          <div className="fishbones-playground-solo">{editorNode}</div>
        ) : (
          <div className="fishbones-playground-solo">{outputNode}</div>
        )}
      </div>

      {/* Phone simulator popout toggle. The simulator itself lives
          in a separate OS window (opened via `openPhonePopout`); the
          button below offers the user a way to focus / re-open it.
          We always render the toggle while we're on a phone-
          eligible language because there's no reliable cross-
          platform Tauri signal for "the user closed the popout
          window OS-style", so the cheapest correct UX is "always
          offer to re-open / focus". `openPhonePopout` is idempotent
          — re-opening an already-open window just focuses it. */}
      {useFloatingPhone && (
        <PhoneToggleButton
          onShow={() => {
            setFloatingPhoneOpen(true);
            void openPhonePopout(phoneScope, `Playground · ${language}`);
            // Replay the latest result into a fresh popout so the
            // window doesn't open empty after a Run already produced
            // output. Mirrors the logic in handleRun() so the bus
            // payload format stays identical.
            if (result) {
              if (language === "reactnative" && result.previewUrl) {
                phoneBus?.emit({ type: "preview", url: result.previewUrl });
              } else {
                phoneBus?.emit({
                  type: "console",
                  logs: result.logs ?? [],
                  error: result.error,
                });
              }
            }
          }}
        />
      )}
    </div>
  );
}
