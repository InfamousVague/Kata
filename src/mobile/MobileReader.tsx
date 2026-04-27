/// Mobile reader. Just markdown — body rendered through the same
/// `renderMarkdown` helper the desktop LessonReader uses, so callouts,
/// code highlighting, and tables come out consistent. No glossary
/// popovers, no inline sandboxes, no enrichment chrome — readability
/// over richness on a 6" screen.

import { useEffect, useState } from "react";
import { renderMarkdown } from "../components/Lesson/markdown";
import "./MobileReader.css";

interface Props {
  body: string;
  onContinue: () => void;
}

export default function MobileReader({ body, onContinue }: Props) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void renderMarkdown(body).then((rendered) => {
      if (!cancelled) setHtml(rendered);
    });
    return () => {
      cancelled = true;
    };
  }, [body]);

  return (
    <div className="m-reader">
      <article
        className="m-reader__prose"
        // Body is markdown rendered to sanitized HTML by markdown-it +
        // Shiki — same pipeline desktop uses.
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
      <button
        type="button"
        className="m-reader__continue"
        onClick={onContinue}
      >
        Mark complete
      </button>
    </div>
  );
}
