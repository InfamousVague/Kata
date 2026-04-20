import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { textToCourse } from "../../ingest/pdfParser";
import type { LanguageId } from "../../data/types";
import "./ImportDialog.css";

interface Props {
  onDismiss: () => void;
  onImported: (courseId: string) => void;
}

/// In-app "Import PDF" wizard. Three steps:
///   1. Pick a PDF via the native dialog.
///   2. Fill in title / language / id.
///   3. Click import — we shell out to pdftotext, parse the text, and save
///      the course via the existing save_course Tauri command.
export default function ImportDialog({ onDismiss, onImported }: Props) {
  const [step, setStep] = useState<"pick" | "meta" | "running">("pick");
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [courseId, setCourseId] = useState("");
  const [language, setLanguage] = useState<LanguageId>("javascript");
  const [useAi, setUseAi] = useState(true);
  const [runningLabel, setRunningLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    setError(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [
          { name: "Books", extensions: ["pdf"] },
        ],
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
    try {
      setRunningLabel("Extracting text from PDF…");
      const res = await invoke<{ text: string; error: string | null }>("extract_pdf_text", {
        path: pdfPath,
      });
      if (res.error) throw new Error(res.error);

      const finalId = courseId || slug(title);

      // Deterministic pass: splits chapters/sections, emits reading lessons.
      let course = textToCourse(res.text, {
        courseId: finalId,
        title,
        author: author || undefined,
        language,
      });

      if (useAi) {
        setRunningLabel(`Structuring with Claude (${course.chapters.length} chapters)…`);
        course = await enhanceWithLLM(course, language, (msg) => setRunningLabel(msg));
      }

      setRunningLabel("Saving course…");
      await invoke("save_course", { courseId: finalId, body: course });
      onImported(finalId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("meta");
    }
  }

  /// Replace the deterministic reading-only lessons in each chapter with
  /// Claude-structured lessons (reading + exercise mix). Runs one API call
  /// per chapter, keeping progress visible.
  async function enhanceWithLLM(
    course: { chapters: { id: string; title: string; lessons: { body?: string }[] }[] },
    language: LanguageId,
    onProgress: (msg: string) => void,
  ) {
    const enhanced = { ...course, chapters: [] as typeof course.chapters };
    for (let i = 0; i < course.chapters.length; i++) {
      const ch = course.chapters[i];
      onProgress(`Structuring chapter ${i + 1}/${course.chapters.length}: ${ch.title}`);
      const sectionText = ch.lessons.map((l) => l.body ?? "").filter(Boolean).join("\n\n");
      if (!sectionText.trim()) {
        enhanced.chapters.push(ch as any);
        continue;
      }
      const raw = await invoke<string>("structure_with_llm", {
        sectionTitle: ch.title,
        sectionText,
        language,
      });
      let lessons;
      try {
        lessons = JSON.parse(raw);
      } catch (e) {
        throw new Error(`LLM returned invalid JSON for ${ch.title}: ${e}`);
      }
      enhanced.chapters.push({ ...ch, lessons });
    }
    return enhanced as any;
  }

  return (
    <div className="kata-import-backdrop" onClick={onDismiss}>
      <div className="kata-import-panel" onClick={(e) => e.stopPropagation()}>
        <div className="kata-import-header">
          <span className="kata-import-title">Import course from PDF</span>
          <button className="kata-import-close" onClick={onDismiss}>
            ×
          </button>
        </div>

        <div className="kata-import-body">
          {step === "pick" && (
            <>
              <p className="kata-import-blurb">
                Pick an O'Reilly-style PDF. We'll extract the text, split it by chapter +
                section, and save it as a new course you can browse in the sidebar.
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
                <input
                  className="kata-import-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. JavaScript: The Definitive Guide"
                />
              </Field>
              <Field label="Author">
                <input
                  className="kata-import-input"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="optional"
                />
              </Field>
              <Field label="Course id">
                <input
                  className="kata-import-input"
                  value={courseId}
                  onChange={(e) => setCourseId(e.target.value)}
                  placeholder="short slug"
                />
              </Field>
              <Field label="Primary language">
                <select
                  className="kata-import-input"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as LanguageId)}
                >
                  <option value="javascript">JavaScript</option>
                  <option value="typescript">TypeScript</option>
                  <option value="python">Python</option>
                  <option value="rust">Rust</option>
                  <option value="swift">Swift</option>
                </select>
              </Field>

              <label className="kata-import-checkbox">
                <input
                  type="checkbox"
                  checked={useAi}
                  onChange={(e) => setUseAi(e.target.checked)}
                />
                <div>
                  <div>Use Claude to structure into exercises</div>
                  <div className="kata-import-hint">
                    Requires an Anthropic API key in Settings. Produces reading +
                    exercise lessons with runnable tests. Off = reading-only splits.
                  </div>
                </div>
              </label>

              <div className="kata-import-actions">
                <button className="kata-import-secondary" onClick={() => setStep("pick")}>
                  Back
                </button>
                <button
                  className="kata-import-primary"
                  onClick={runImport}
                  disabled={!title || !courseId}
                >
                  Import
                </button>
              </div>
            </>
          )}

          {step === "running" && (
            <div className="kata-import-running">
              <div className="kata-import-spinner" />
              <span>{runningLabel || "Working…"}</span>
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
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "course";
}

function toTitle(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
