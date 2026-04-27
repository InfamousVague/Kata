/// In-app documentation system. Each page is a self-contained markdown
/// string rendered through the same `renderMarkdown` pipeline LessonReader
/// uses — that gets us Shiki syntax highlighting, GitHub-style callouts,
/// and the existing reader CSS for free.
///
/// Pages are grouped into sections shown as collapsible groups in the docs
/// sidebar. The data structure is intentionally minimal — adding a page is
/// a one-object commit, not a route registration.

export interface DocsPage {
  /// URL-safe id used for in-app navigation (the docs view tracks this in
  /// state — the app isn't truly URL-routed). Also used as the React key
  /// when rendering the sidebar.
  id: string;
  /// Title shown in the sidebar and as the H1 above the rendered body.
  title: string;
  /// One-line summary surfaced as a hover tooltip on the sidebar entry.
  /// Optional — pages without a tagline still render fine.
  tagline?: string;
  /// Markdown body. Code fences with a language tag get Shiki highlighting
  /// (`tsx`, `ts`, `rust`, `bash`, `json`, `css`, etc.). GitHub-style
  /// callouts (> [!NOTE] / [!TIP] / [!WARNING] / [!EXAMPLE]) get the same
  /// styled boxes lessons use.
  body: string;
}

export interface DocsSection {
  /// URL-safe id; used for the section header and for grouping pages in
  /// the sidebar.
  id: string;
  /// Section name shown above its pages in the sidebar.
  title: string;
  /// Pages in display order. Empty sections are valid (e.g. for a
  /// placeholder while content is in flight).
  pages: DocsPage[];
}
