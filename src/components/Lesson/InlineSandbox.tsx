// Side-effect import: configures `@monaco-editor/react`'s loader to use
// the locally-bundled Monaco instance + wires `self.MonacoEnvironment`
// for worker spawning. Same import EditorPane uses; the file's
// side-effects are idempotent so importing it from both places is safe
// (modules are evaluated once per graph). See monaco-setup.ts.
import "../../lib/monaco-setup";
import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { runCode, type RunResult } from "../../runtimes";
import { useActiveTheme } from "../../theme/useActiveTheme";
import { MONACO_THEME_BY_APP_THEME } from "../../theme/monaco-themes";
import type { LanguageId } from "../../data/types";
import "./InlineSandbox.css";

interface Props {
  /// Primary language the snippet runs in. Matches the fenced code
  /// block's info string (e.g. ```rust playground → language="rust").
  language: LanguageId;
  /// Starter code (already decoded from the base64 payload in the
  /// markdown renderer). The editor seeds with this value on mount
  /// and tracks local edits; there's no persistence — each inline
  /// sandbox resets to the starter on lesson re-render.
  initialCode: string;
}

const VALID_LANGS: readonly LanguageId[] = [
  "javascript",
  "typescript",
  "python",
  "rust",
  "swift",
  "go",
];

/// Small Monaco + Run button + output strip embedded in prose. Meant for
/// "try it" snippets — no tests, no solution, no state persisted. When
/// the lesson re-renders the sandbox re-mounts and loses its edits,
/// which is the right trade-off: the whole point is a scratch sandbox,
/// not a workspace.
export default function InlineSandbox({ language, initialCode }: Props) {
  const [code, setCode] = useState<string>(initialCode);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const activeTheme = useActiveTheme();
  const monacoTheme = MONACO_THEME_BY_APP_THEME[activeTheme];

  // Defensively coerce unexpected languages to plaintext-ish run. The
  // markdown renderer already filters to known infostrings but this is
  // a thin extra guard before invoking the runtime dispatcher.
  const safeLang: LanguageId = useMemo(
    () => (VALID_LANGS.includes(language) ? language : "javascript"),
    [language],
  );

  async function handleRun() {
    setRunning(true);
    setResult(null);
    try {
      const r = await runCode(safeLang, code);
      setResult(r);
    } finally {
      setRunning(false);
    }
  }

  function handleReset() {
    setCode(initialCode);
    setResult(null);
  }

  // Line count drives the editor height so we don't leave a giant empty
  // box for a 3-line snippet. Cap so a 20-line "try it" still scrolls
  // rather than pushing the prose below it off-screen.
  const lineCount = Math.max(3, Math.min(code.split("\n").length, 12));
  const editorHeight = `${lineCount * 18 + 10}px`;

  return (
    <div className="fishbones-inline-sandbox-root">
      <div className="fishbones-inline-sandbox-header">
        <span className="fishbones-inline-sandbox-lang">{safeLang}</span>
        <span className="fishbones-inline-sandbox-label">Try it</span>
        <div className="fishbones-inline-sandbox-actions">
          <button
            type="button"
            className="fishbones-inline-sandbox-btn"
            onClick={handleReset}
          >
            reset
          </button>
          <button
            type="button"
            className="fishbones-inline-sandbox-btn fishbones-inline-sandbox-btn--run"
            onClick={handleRun}
            disabled={running}
          >
            {running ? "running…" : "run"}
          </button>
        </div>
      </div>
      <div
        className="fishbones-inline-sandbox-editor"
        style={{ height: editorHeight }}
      >
        <Editor
          height="100%"
          language={safeLang}
          value={code}
          theme={monacoTheme}
          onChange={(v) => setCode(v ?? "")}
          options={{
            minimap: { enabled: false },
            fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
            fontSize: 12.5,
            scrollBeyondLastLine: false,
            lineNumbers: "off",
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
            padding: { top: 6, bottom: 6 },
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            scrollbar: { vertical: "auto", horizontal: "auto" },
          }}
        />
      </div>
      {(result || running) && (
        <div className="fishbones-inline-sandbox-output">
          {running && <div className="fishbones-inline-sandbox-out-hint">running…</div>}
          {result && (
            <>
              {result.error && (
                <div className="fishbones-inline-sandbox-out-error">
                  {result.error}
                </div>
              )}
              {result.logs.map((line, i) => (
                <div
                  key={i}
                  className={`fishbones-inline-sandbox-out-line fishbones-inline-sandbox-out-line--${line.level}`}
                >
                  {line.text}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
