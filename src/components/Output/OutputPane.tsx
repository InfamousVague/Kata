import type { RunResult } from "../../runtimes";
import "./OutputPane.css";

interface Props {
  result: RunResult | null;
  running: boolean;
}

/// Bottom-right pane. Renders structured runtime output: captured console
/// logs, errors, and — when the lesson has hidden tests — per-test pass/fail
/// lines.
export default function OutputPane({ result, running }: Props) {
  const passedCount = result?.tests?.filter((t) => t.passed).length ?? 0;
  const totalTests = result?.tests?.length ?? 0;
  const allPassed = totalTests > 0 && passedCount === totalTests && !result?.error;

  return (
    <div className="kata-output">
      <div className="kata-output-header">
        <span className="kata-output-label">console</span>
        <div className="kata-output-header-right">
          {totalTests > 0 && !running && (
            <span
              className={`kata-output-tests-summary ${
                allPassed ? "kata-output-tests-summary--pass" : "kata-output-tests-summary--fail"
              }`}
            >
              {passedCount}/{totalTests} passed
            </span>
          )}
          {result && !running && (
            <span className="kata-output-duration">{result.durationMs.toFixed(0)}ms</span>
          )}
          {running && <span className="kata-output-duration">running…</span>}
        </div>
      </div>

      <div className="kata-output-body">
        {!result && !running && (
          <div className="kata-output-empty">run your code to see output here</div>
        )}

        {result?.logs.map((line, i) => (
          <div key={`log-${i}`} className={`kata-output-line kata-output-line--${line.level}`}>
            {line.text}
          </div>
        ))}

        {result?.tests && result.tests.length > 0 && (
          <div className="kata-output-tests">
            {result.tests.map((t, i) => (
              <div
                key={`t-${i}`}
                className={`kata-output-test kata-output-test--${t.passed ? "pass" : "fail"}`}
              >
                <span className="kata-output-test-glyph">{t.passed ? "✓" : "✗"}</span>
                <span className="kata-output-test-name">{t.name}</span>
                {!t.passed && t.error && (
                  <pre className="kata-output-test-error">{t.error}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {result?.error && (
          <div className="kata-output-error">
            <div className="kata-output-error-title">error</div>
            <pre>{result.error}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
