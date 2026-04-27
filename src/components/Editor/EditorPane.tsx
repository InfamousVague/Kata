// Side-effect import: wires `self.MonacoEnvironment` and points
// `@monaco-editor/react`'s loader at our bundled Monaco instance. MUST come
// before the `@monaco-editor/react` import below so the loader is
// configured before any Editor component mounts. See monaco-setup.ts for
// the full rationale (signed-production CDN-load issue).
import "../../lib/monaco-setup";
import { useState } from "react";
import Editor from "@monaco-editor/react";
import { Icon } from "@base/primitives/icon";
import { arrowLeft } from "@base/primitives/icon/icons/arrow-left";
import { arrowRight } from "@base/primitives/icon/icons/arrow-right";
import "@base/primitives/icon/icon.css";
import type { FileLanguage, LanguageId, WorkbenchFile } from "../../data/types";
import { useActiveTheme } from "../../theme/useActiveTheme";
import { MONACO_THEME_BY_APP_THEME, registerMonacoThemes } from "../../theme/monaco-themes";
import "./EditorPane.css";

// Themes + ambient CommonJS decls are still applied per-mount via
// `beforeMount` below — `defineTheme` and `addExtraLib` are idempotent
// keyed by name, so the duplicate calls are cheap and ensure our
// customizations are in place before the first paint.
//
// We declare CommonJS globals (`module`, `exports`, `require`) as an
// ambient type-lib so Monaco's TypeScript language service stops flagging
// `module.exports = { ... }` in exercise starters. Fishbones' JS/TS
// lessons use the CommonJS module pattern (the test harness does
// `require('./user')` against the learner's exports), but Monaco's
// default TS config has no Node globals — it was rendering every
// `module.exports` underline-red with "Cannot find name 'module'".
// Declaring them as `any` here tells the language service they exist
// without forcing us to pull in `@types/node` (which would bring hundreds
// of other globals the lessons shouldn't care about).

const COMMONJS_AMBIENT = `
// Fishbones ambient declarations — keeps the learner's CommonJS-style
// starter (module.exports = { ... }, const x = require('./user')) from
// showing bogus "Cannot find name 'module'" squiggles in Monaco. The
// runtime handles the actual module plumbing; the editor just needs to
// know the globals exist.
declare const module: { exports: any };
declare const exports: any;
declare function require(name: string): any;
declare const __dirname: string;
declare const __filename: string;
declare const process: { env: Record<string, string | undefined> };
`;

function addCommonJsAmbientDecls(monaco: typeof import("monaco-editor")) {
  try {
    // Add to both TS and JS language services — Monaco checks them
    // independently, and some lessons may use the `.js` extension.
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      COMMONJS_AMBIENT,
      "file:///fishbones-commonjs.d.ts",
    );
    monaco.languages.typescript.javascriptDefaults.addExtraLib(
      COMMONJS_AMBIENT,
      "file:///fishbones-commonjs.d.ts",
    );
  } catch {
    // If Monaco's API shape ever changes or the typescript worker isn't
    // loaded yet, we'd rather the editor keep working than crash. The
    // underline remains visible but everything else is unaffected.
  }
}

interface Props {
  /// Primary lesson language — displayed as the toolbar badge and kept for
  /// tooltip purposes. Individual files carry their own Monaco language.
  language: LanguageId;
  /// Open files, in display order. Array length >= 1. Legacy single-file
  /// lessons pass a one-element array synthesized from `starter`.
  files: WorkbenchFile[];
  /// Index into `files` of the currently-edited file. The editor mounts a
  /// fresh Monaco model when this changes so the scroll/selection state is
  /// per-file rather than shared.
  activeIndex: number;
  /// File tab click. Parent updates its activeIndex state.
  onActiveIndexChange: (index: number) => void;
  /// Per-file edit handler. Parent replaces the content of `files[index]`.
  onChange: (index: number, nextContent: string) => void;
  onRun: () => void;
  /// Optional hints, revealed progressively. Parent doesn't need to track
  /// the revealed count — EditorPane owns that state because App-level
  /// LessonView is already keyed by lessonId, so this component remounts
  /// and resets on every lesson change.
  hints?: string[];
  /// Restore the exercise's starter code. Disabled if omitted.
  onReset?: () => void;
  /// Overwrite the editor with the reference solution. Shown behind a
  /// confirmation because it's destructive to the user's in-progress code.
  onRevealSolution?: () => void;
  /// Open the editor + console in a detached window. Disabled if omitted
  /// (e.g. when the EditorPane is already rendered inside the popped-out
  /// window).
  onPopOut?: () => void;
}

const MONACO_LANGUAGES: Record<FileLanguage, string> = {
  javascript: "javascript",
  typescript: "typescript",
  python: "python",
  rust: "rust",
  swift: "swift",
  go: "go",
  c: "c",
  cpp: "cpp",
  java: "java",
  kotlin: "kotlin",
  csharp: "csharp",
  // Monaco doesn't ship a generic `assembly` language — use its
  // built-in `mips` colourer, which highlights mnemonics + registers
  // well enough for most snippets. A proper arm64/x86_64 Monarch
  // tokenizer would be nicer long-term; this keeps the pane from
  // falling back to plain-text in the meantime.
  assembly: "mips",
  html: "html",
  css: "css",
  json: "json",
  // Svelte uses our hand-rolled Monarch grammar (lib/monaco-svelte.ts)
  // registered via lib/monaco-setup.ts. The id matches what
  // setMonarchTokensProvider was registered against — without this
  // mapping `.svelte` files render as plaintext even though the
  // grammar exists.
  svelte: "svelte",
  // Solidity uses a hand-rolled Monarch grammar (lib/monaco-solidity.ts)
  // registered via lib/monaco-setup.ts. Monaco doesn't ship a Solidity
  // language built in, so without this mapping `.sol` files would
  // render as plaintext.
  solidity: "solidity",
  // Monaco's built-in markdown is fine for lesson-body fragments
  // (.md files in mixed-lesson file sets) — wire it up so the
  // editor doesn't fall through to plaintext on those.
  markdown: "markdown",
  plaintext: "plaintext",
};

/// Left half of the workbench. Wraps Monaco with a small header (language +
/// hint / reset / reveal / run / pop-out buttons) and a collapsible hint
/// panel that shows progressively as the learner asks for help.
export default function EditorPane({
  language,
  files,
  activeIndex,
  onActiveIndexChange,
  onChange,
  onRun,
  hints,
  onReset,
  onRevealSolution,
  onPopOut,
}: Props) {
  // Guard: activeIndex can briefly be out-of-range during file-list swaps
  // (e.g. reveal-solution replacing the whole array). Clamp to a valid
  // position so Monaco doesn't receive an undefined value.
  const safeIndex = Math.max(0, Math.min(activeIndex, files.length - 1));
  const active = files[safeIndex];
  const hasHints = !!hints && hints.length > 0;
  // `revealed` — how many hints the learner has unlocked so far (0..N).
  // `currentIdx` — which revealed hint is currently displayed in the panel.
  // `open` — whether the panel is visible. Closing with X hides without
  // losing progress, so clicking Hint again reopens at the same spot.
  const [revealed, setRevealed] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const [confirmingReveal, setConfirmingReveal] = useState(false);
  const activeTheme = useActiveTheme();
  const monacoTheme = MONACO_THEME_BY_APP_THEME[activeTheme];

  /// Toolbar Hint button behavior: if there are still unrevealed hints,
  /// reveal the next one AND jump to it. If everything is already revealed,
  /// just re-open the panel at the last position the learner was viewing.
  function onHintClick() {
    if (!hasHints) return;
    if (revealed < hints!.length) {
      const next = revealed + 1;
      setRevealed(next);
      setCurrentIdx(next - 1);
    } else {
      setCurrentIdx(hints!.length - 1);
    }
    setOpen(true);
  }

  function prevHint() {
    setCurrentIdx((i) => Math.max(0, i - 1));
  }

  /// Panel-level Next: if we're at the end of the revealed set but more
  /// exist, unlock one; otherwise just advance through already-seen hints.
  function nextHint() {
    if (!hasHints) return;
    if (currentIdx < revealed - 1) {
      setCurrentIdx((i) => i + 1);
    } else if (revealed < hints!.length) {
      const next = revealed + 1;
      setRevealed(next);
      setCurrentIdx(next - 1);
    }
  }

  function confirmReveal() {
    if (!onRevealSolution) return;
    onRevealSolution();
    setConfirmingReveal(false);
  }

  const multiFile = files.length > 1;

  return (
    <div className="fishbones-editor">
      <div className="fishbones-editor-header">
        <span className="fishbones-editor-language">{language}</span>
        <div className="fishbones-editor-actions">
          {hasHints && (
            <button
              className="fishbones-editor-button fishbones-editor-hint"
              onClick={onHintClick}
              title="Reveal a progressively more specific hint"
            >
              hint {revealed}/{hints!.length}
            </button>
          )}
          {onReset && (
            <button
              className="fishbones-editor-button"
              onClick={onReset}
              title="Restore the starter code"
            >
              reset
            </button>
          )}
          {onRevealSolution && (
            <button
              className="fishbones-editor-button"
              onClick={() => setConfirmingReveal(true)}
              title="Overwrite your code with the reference solution"
            >
              solution
            </button>
          )}
          {onPopOut && (
            <button
              className="fishbones-editor-button"
              onClick={onPopOut}
              title="Open editor + console in a separate window"
            >
              ⇱
            </button>
          )}
          <button className="fishbones-editor-button fishbones-editor-run" onClick={onRun}>
            run
          </button>
        </div>
      </div>

      {multiFile && (
        <div className="fishbones-editor-tabs" role="tablist" aria-label="Workbench files">
          {files.map((f, i) => (
            <button
              key={f.name}
              role="tab"
              aria-selected={i === safeIndex}
              className={`fishbones-editor-tab ${
                i === safeIndex ? "fishbones-editor-tab--active" : ""
              } ${f.readOnly ? "fishbones-editor-tab--readonly" : ""}`}
              onClick={() => onActiveIndexChange(i)}
              title={f.readOnly ? `${f.name} (read-only)` : f.name}
            >
              <span className="fishbones-editor-tab-name">{f.name}</span>
              {f.readOnly && (
                <span className="fishbones-editor-tab-badge" aria-hidden>
                  🔒
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {hasHints && open && revealed > 0 && (
        <div className="fishbones-editor-hints">
          <div className="fishbones-editor-hints-header">
            <span className="fishbones-editor-hints-label">
              Hint {currentIdx + 1} of {hints!.length}
              {revealed < hints!.length && (
                <span className="fishbones-editor-hints-locked">
                  {" "}
                  · {hints!.length - revealed} locked
                </span>
              )}
            </span>
            <button
              className="fishbones-editor-hints-close"
              onClick={() => setOpen(false)}
              title="Close hints"
              aria-label="Close hints"
            >
              ×
            </button>
          </div>

          <div className="fishbones-editor-hints-body">{hints![currentIdx]}</div>

          <div className="fishbones-editor-hints-nav">
            <button
              className="fishbones-editor-hints-nav-btn"
              onClick={prevHint}
              disabled={currentIdx === 0}
              aria-label="Previous hint"
            >
              <Icon icon={arrowLeft} size="xs" color="currentColor" />
              prev
            </button>
            <div className="fishbones-editor-hints-pips" aria-hidden>
              {hints!.map((_, i) => (
                <span
                  key={i}
                  className={
                    "fishbones-editor-hints-pip" +
                    (i === currentIdx ? " fishbones-editor-hints-pip--current" : "") +
                    (i >= revealed ? " fishbones-editor-hints-pip--locked" : "")
                  }
                />
              ))}
            </div>
            <button
              className="fishbones-editor-hints-nav-btn"
              onClick={nextHint}
              disabled={
                currentIdx === revealed - 1 && revealed === hints!.length
              }
              aria-label={
                currentIdx < revealed - 1 ? "Next hint" : "Unlock next hint"
              }
            >
              {currentIdx < revealed - 1 ? "next" : "reveal next"}
              <Icon icon={arrowRight} size="xs" color="currentColor" />
            </button>
          </div>
        </div>
      )}

      <div className="fishbones-editor-host">
        {active && (
          <Editor
            height="100%"
            // `path` gives each file its own Monaco model, so undo history,
            // cursor position, and scroll state are preserved per-tab. The
            // `key` prevents model leakage when the file list is swapped
            // wholesale (e.g. reveal-solution replacing everything).
            key={active.name}
            path={active.name}
            language={MONACO_LANGUAGES[active.language] ?? "plaintext"}
            value={active.content}
            theme={monacoTheme}
            beforeMount={(monaco) => {
              // Re-register on every mount as a safety net — Monaco's theme
              // cache is per-instance and defineTheme is idempotent by name,
              // so repeated calls are cheap and guarantee our themes exist
              // before the first paint even if loader.init resolved late.
              registerMonacoThemes(monaco);
              // Same idempotent safety net for the CommonJS ambient decls:
              // `addExtraLib` replaces any earlier registration under the
              // same virtual filename, so re-calling it mid-mount is a
              // no-op once the globals are already declared.
              addCommonJsAmbientDecls(monaco);
            }}
            onChange={(v) => onChange(safeIndex, v ?? "")}
            options={{
              fontSize: 13,
              fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbersMinChars: 3,
              tabSize: 2,
              automaticLayout: true,
              renderLineHighlight: "gutter",
              readOnly: !!active.readOnly,
            }}
          />
        )}
      </div>

      {confirmingReveal && (
        <div className="fishbones-editor-modal-backdrop" onClick={() => setConfirmingReveal(false)}>
          <div className="fishbones-editor-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fishbones-editor-modal-title">Reveal reference solution?</div>
            <p className="fishbones-editor-modal-body">
              This will replace your current code with the hidden reference solution.
              Your in-progress work will be lost.
            </p>
            <div className="fishbones-editor-modal-actions">
              <button
                className="fishbones-editor-button"
                onClick={() => setConfirmingReveal(false)}
              >
                cancel
              </button>
              <button
                className="fishbones-editor-button fishbones-editor-button--danger"
                onClick={confirmReveal}
              >
                reveal solution
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
