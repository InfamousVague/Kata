import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { textToCourse } from "../../ingest/pdfParser";
import { runPipeline } from "../../ingest/pipeline";
import CoursePreview from "./CoursePreview";
import type { Course, LanguageId } from "../../data/types";
import "./ImportDialog.css";

interface Props {
  onDismiss: () => void;
  onImported: (courseId: string) => void;
}

/// Import wizard with four possible steps:
///   1. "pick"    — file picker
///   2. "meta"    — metadata + AI toggle
///   3. "running" — progress label while the pipeline runs
///   4. "preview" — full-screen review of the generated course before save
export default function ImportDialog({ onDismiss, onImported }: Props) {
  const [step, setStep] = useState<"pick" | "meta" | "running" | "preview">("pick");
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [courseId, setCourseId] = useState("");
  const [language, setLanguage] = useState<LanguageId>("javascript");
  const [useAi, setUseAi] = useState(true);
  const [runningLabel, setRunningLabel] = useState("");
  const [runningDetail, setRunningDetail] = useState("");
  const [previewCourse, setPreviewCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    setError(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Books", extensions: ["pdf"] }],
      });
      if (typeof picked !== "string") return;
      setPdfPath(picked);
      const base = basename(picked).replace(/\.pdf$/i, "");
      setTitle((t) => t || toTitle(base));
      setCourseId((id) => id || slug(base));
      setStep("meta");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runImport() {
    if (!pdfPath) return;
    setStep("running");
    setError(null);
    setPreviewCourse(null);
    try {
      const finalId = courseId || slug(title);

      let course: Course;
      if (useAi) {
        // Full specialist-chain pipeline with caching + validation.
        course = await runPipeline({
          pdfPath,
          bookId: finalId,
          title,
          author: author || undefined,
          language,
          onProgress: (stage, detail) => {
            setRunningLabel(stage);
            setRunningDetail(detail ?? "");
          },
        });
      } else {
        // Deterministic-only path: pdftotext → section splits → reading lessons.
        setRunningLabel("Extracting text from PDF…");
        const res = await invoke<{ text: string; error: string | null }>(
          "extract_pdf_text",
          { path: pdfPath },
        );
        if (res.error) throw new Error(res.error);
        course = textToCourse(res.text, {
          courseId: finalId,
          title,
          author: author || undefined,
          language,
        });
      }

      setPreviewCourse(course);
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("meta");
    }
  }

  async function commitSave() {
    if (!previewCourse) return;
    try {
      await invoke("save_course", {
        courseId: previewCourse.id,
        body: previewCourse,
      });
      onImported(previewCourse.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (step === "preview" && previewCourse) {
    return (
      <CoursePreview
        course={previewCourse}
        onSave={commitSave}
        onDiscard={() => {
          setPreviewCourse(null);
          setStep("meta");
        }}
      />
    );
  }

  return (
    <div className="kata-import-backdrop" onClick={onDismiss}>
      <div className="kata-import-panel" onClick={(e) => e.stopPropagation()}>
        <div className="kata-import-header">
          <span className="kata-import-title">Import course from PDF</span>
          <button className="kata-import-close" onClick={onDismiss}>×</button>
        </div>

        <div className="kata-import-body">
          {step === "pick" && (
            <>
              <p className="kata-import-blurb">
                Pick a PDF. We'll extract the text, split by chapter + section, and —
                if you've got an Anthropic key in Settings — use Claude to structure
                it into a real Codecademy-style course with exercises and quizzes.
              </p>
              <button className="kata-import-primary" onClick={pickFile}>
                Choose PDF…
              </button>
            </>
          )}

          {step === "meta" && (
            <>
              <Field label="PDF">
                <code className="kata-import-path">{pdfPath}</code>
              </Field>
              <Field label="Title">
                <input className="kata-import-input" value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. JavaScript: The Definitive Guide" />
              </Field>
              <Field label="Author">
                <input className="kata-import-input" value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="optional" />
              </Field>
              <Field label="Course id">
                <input className="kata-import-input" value={courseId}
                  onChange={(e) => setCourseId(e.target.value)}
                  placeholder="short slug" />
              </Field>
              <Field label="Primary language">
                <select className="kata-import-input" value={language}
                  onChange={(e) => setLanguage(e.target.value as LanguageId)}>
                  <option value="javascript">JavaScript</option>
                  <option value="typescript">TypeScript</option>
                  <option value="python">Python</option>
                  <option value="rust">Rust</option>
                  <option value="swift">Swift</option>
                </select>
              </Field>

              <label className="kata-import-checkbox">
                <input type="checkbox" checked={useAi}
                  onChange={(e) => setUseAi(e.target.checked)} />
                <div>
                  <div>Use Claude to structure into lessons</div>
                  <div className="kata-import-hint">
                    Requires an Anthropic key in Settings. Runs the full
                    specialist-chain pipeline (clean code → outline → per-lesson →
                    validate + retry 3x). Cached per-stage so re-runs are cheap.
                    Off = reading-only section splits.
                  </div>
                </div>
              </label>

              <div className="kata-import-actions">
                <button className="kata-import-secondary" onClick={() => setStep("pick")}>Back</button>
                <button className="kata-import-primary" onClick={runImport}
                  disabled={!title || !courseId}>Import</button>
              </div>
            </>
          )}

          {step === "running" && (
            <div className="kata-import-running-panel">
              <div className="kata-import-spinner" />
              <div className="kata-import-running-body">
                <div className="kata-import-running-stage">{runningLabel || "Working…"}</div>
                {runningDetail && <div className="kata-import-running-detail">{runningDetail}</div>}
              </div>
            </div>
          )}

          {error && <div className="kata-import-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="kata-import-field">
      <span className="kata-import-label">{label}</span>
      {children}
    </label>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function slug(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "course";
}

function toTitle(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
