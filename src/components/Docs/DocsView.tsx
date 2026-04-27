import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { chevronRight } from "@base/primitives/icon/icons/chevron-right";
import { renderMarkdown } from "../Lesson/markdown";
import {
  FISHBONES_DOCS,
  FISHBONES_DOCS_INDEX,
} from "../../docs/pages";
import type { DocsPage, DocsSection } from "../../docs/types";
import "../Lesson/LessonReader.css";
import "./DocsView.css";

/// In-app documentation viewer. Single-column main pane: the sidebar
/// nav (section ▸ page) lives in the main app `Sidebar` now (when
/// `activeView === "docs"` it swaps its course tree for the docs
/// nav), so DocsView just renders the active page's markdown body
/// through the same `renderMarkdown` pipeline LessonReader uses (so
/// we get Shiki highlighting + GFM + callouts for free).
///
/// Active-page state is **lifted to App-level** so the sidebar list
/// and this main pane stay in sync without a duplicate sidebar. The
/// component is purely controlled — App owns `activeId` and passes
/// `onActiveIdChange` for the prev/next chips and `docs:<id>` link
/// rewrites to call back.
export interface DocsViewProps {
  /// Currently-visible page id. Resolved against
  /// `FISHBONES_DOCS_INDEX`; if it doesn't match anything we fall
  /// back to the first page so the pane never blanks out.
  activeId: string;
  /// Called when the user clicks a prev/next chip or follows a
  /// `docs:<page-id>` link inside the rendered markdown.
  onActiveIdChange: (id: string) => void;
}

export default function DocsView({
  activeId,
  onActiveIdChange,
}: DocsViewProps) {
  const active = useMemo(() => {
    const hit = FISHBONES_DOCS_INDEX.get(activeId);
    if (!hit) {
      return {
        section: FISHBONES_DOCS[0],
        page: FISHBONES_DOCS[0]?.pages[0],
      };
    }
    return { section: hit.section, page: hit.section.pages[hit.pageIndex] };
  }, [activeId]);

  /// Markdown → HTML render. Re-runs whenever the active page changes.
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    if (!active.page) return;
    let cancelled = false;
    renderMarkdown(active.page.body).then((rendered) => {
      if (!cancelled) setHtml(rendered);
    });
    return () => {
      cancelled = true;
    };
  }, [active.page?.id, active.page?.body]);

  /// Auto-scroll the content pane back to the top whenever the active
  /// page changes — otherwise navigating from a long page leaves the
  /// new page scrolled mid-way down.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activeId]);

  /// Intercept clicks on `docs:<page-id>` links inside the rendered
  /// markdown so they navigate within the docs view instead of trying
  /// to open as URLs (which the Tauri webview would ignore).
  const onContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest("a");
    if (!target) return;
    const href = target.getAttribute("href") ?? "";
    if (href.startsWith("docs:")) {
      e.preventDefault();
      const pageId = href.slice("docs:".length);
      if (FISHBONES_DOCS_INDEX.has(pageId)) {
        onActiveIdChange(pageId);
      }
    }
  };

  /// Find prev/next pages for the bottom-of-page navigation chips. Walks
  /// the flat list across sections so going Next from the last page in
  /// section A lands on the first page of section B.
  const flatPages = useMemo(() => {
    const out: Array<{ section: DocsSection; page: DocsPage }> = [];
    for (const s of FISHBONES_DOCS) {
      for (const p of s.pages) out.push({ section: s, page: p });
    }
    return out;
  }, []);
  const flatIndex = flatPages.findIndex((x) => x.page.id === activeId);
  const prevPage = flatIndex > 0 ? flatPages[flatIndex - 1] : null;
  const nextPage =
    flatIndex >= 0 && flatIndex < flatPages.length - 1
      ? flatPages[flatIndex + 1]
      : null;

  return (
    <section className="fishbones-docs">
      <div className="fishbones-docs-main">
        <div className="fishbones-reader-scroll" ref={scrollRef}>
          <div className="fishbones-docs-inner">
            <div className="fishbones-docs-breadcrumb">
              {active.section?.title}
              <Icon
                icon={chevronRight}
                size="xs"
                color="currentColor"
                weight="regular"
              />
              {active.page?.title}
            </div>
            <h1 className="fishbones-reader-title">{active.page?.title}</h1>
            {active.page?.tagline && (
              <p className="fishbones-docs-tagline">{active.page.tagline}</p>
            )}
            <div
              className="fishbones-reader-body"
              onClick={onContentClick}
              dangerouslySetInnerHTML={{ __html: html }}
            />

            <div className="fishbones-docs-footer-nav">
              {prevPage ? (
                <button
                  type="button"
                  className="fishbones-docs-footer-chip prev"
                  onClick={() => onActiveIdChange(prevPage.page.id)}
                >
                  <span className="fishbones-docs-footer-chip-label">
                    Previous
                  </span>
                  <span className="fishbones-docs-footer-chip-title">
                    {prevPage.page.title}
                  </span>
                </button>
              ) : (
                <span />
              )}
              {nextPage ? (
                <button
                  type="button"
                  className="fishbones-docs-footer-chip next"
                  onClick={() => onActiveIdChange(nextPage.page.id)}
                >
                  <span className="fishbones-docs-footer-chip-label">
                    Next
                  </span>
                  <span className="fishbones-docs-footer-chip-title">
                    {nextPage.page.title}
                  </span>
                </button>
              ) : (
                <span />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
