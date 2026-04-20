import type { RunResult } from "../../runtimes";
import "./OutputPane.css";

interface Props {
  result: RunResult | null;
  running: boolean;
}

/// Bottom-right pane. Renders structured runtime output: each captured
/// console call as its own line, plus a footer with duration and errors
/// surfaced in red with their stack trace.
export default function OutputPane({ result, running }: Props) {
  return (
    <div className="kata-output">
      <div className="kata-output-header">
        <span className="kata-output-label">console</span>
        {result && !running && (
          <span className="kata-output-duration">{result.durationMs.toFixed(0)}ms</span>
        )}
        {running && <span className="kata-output-duration">running…</span>}
      </div>

      <div className="kata-output-body">
        {!result && !running && (
          <div className="kata-output-empty">run your code to see output here</div>
        )}

        {result?.logs.map((line, i) => (
          <div key={i} className={`kata-output-line kata-output-line--${line.level}`}>
            {line.text}
          </div>
        ))}

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
