import MarkdownIt from "markdown-it";
import { codeToHtml } from "shiki";
import { info as infoIcon } from "@base/primitives/icon/icons/info";
import { triangleAlert } from "@base/primitives/icon/icons/triangle-alert";
import { lightbulb } from "@base/primitives/icon/icons/lightbulb";
import { flaskConical } from "@base/primitives/icon/icons/flask-conical";
import type {
  LessonEnrichment,
  GlossaryEntry,
  SymbolEntry,
} from "../../data/types";

/// Markdown → HTML using markdown-it (CommonMark + GFM tables). Fenced code
/// blocks are piped through Shiki for syntax highlighting.
///
/// This module is also the single place reading-aid enrichment is woven
/// into the prose:
///   - GitHub-style callouts (> [!NOTE] / [!WARNING] / [!TIP] / [!EXAMPLE])
///     become styled boxes with a colored icon strip.
///   - Fenced code blocks whose info string includes `playground` become
///     inline-sandbox markers that LessonReader later hydrates into small
///     Monaco editors with a Run button.
///   - Inline `<code>` tokens that match a symbol in the lesson's
///     enrichment table get wrapped in a popover trigger. We only wrap
///     the FIRST occurrence of each symbol per lesson so the prose
///     doesn't turn into link-soup.
///   - Glossary terms get the same first-occurrence-only treatment,
///     dotted-underline styling, and popover trigger with the definition.
///
/// Each enrichment produces inert HTML markers (data-* attributes + a
/// well-known class). LessonReader finds them after render and hydrates
/// the interactive pieces. Keeps this file pure (no React) and the
/// reader pure (no string-munging).
///
/// We use async render because Shiki's highlighter is async-only in the
/// browser build. markdown-it's `highlight` option is sync, so we do a
/// two-pass render: (1) let markdown-it emit unhighlighted code with a
/// placeholder class, (2) scan the HTML for those placeholders and replace
/// their contents with Shiki output.

const SHIKI_THEME = "github-dark";

const md = new MarkdownIt({
  html: false, // refuse inline HTML — lesson content is trusted but we don't want it
  linkify: true, // autolink bare URLs
  typographer: false, // keep straight quotes so code samples look right inline
  breaks: false, // require a blank line for hard breaks, matching GFM behavior
});

// Render code blocks with a data attribute + escaped raw so we can find them
// post-render and re-emit with Shiki. Using `data-fishbones-lang` so Shiki's own
// output class doesn't collide if we ever swap the theme at runtime.
//
// When the info string contains the word `playground` (e.g. ```rust playground),
// we emit an inline-sandbox marker instead so LessonReader can hydrate it
// into a tiny Monaco + Run component. The sandbox marker carries the same
// base64-encoded source so nothing downstream has to re-parse the fence.
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const infoParts = (token.info || "").trim().split(/\s+/);
  const lang = infoParts[0] || "text";
  const isPlayground = infoParts.slice(1).includes("playground");
  // Tutorial filename convention — Svelte's tutorial markdown (and a
  // few others we've imported) prefixes every code fence with a
  // `/// file: App.svelte` header line so the learner knows which
  // file the snippet belongs to. Their official site renders that as
  // a small filename strip above the code; we do the same. If we
  // don't strip it, Shiki tries to highlight `/// file: …` as part
  // of the source — at best it shows up as a bare comment-ish line,
  // at worst (in Svelte's case) it confuses the grammar.
  const { content: raw, filename } = extractFileHeader(token.content);
  // Base64-encode so the raw source survives HTML attribute quoting. It's
  // picked back up by the post-processor below and handed to Shiki.
  const b64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(raw)))
    : Buffer.from(raw, "utf-8").toString("base64");
  if (isPlayground) {
    return `<div class="fishbones-inline-sandbox" data-fishbones-lang="${escapeAttr(lang)}" data-fishbones-src="${b64}"></div>`;
  }
  const filenameAttr = filename
    ? ` data-fishbones-filename="${escapeAttr(filename)}"`
    : "";
  return `<pre class="fishbones-code-pending" data-fishbones-lang="${escapeAttr(lang)}" data-fishbones-src="${b64}"${filenameAttr}></pre>`;
};

/// Detect a leading `/// file: <path>` header line on a code-fence
/// payload, strip it, and return the cleaned content plus the
/// filename. Used by the fence renderer to render filenames as a
/// chrome strip above the code rather than as part of the syntax-
/// highlighted body. Returns no filename when the convention isn't
/// present, in which case the content is returned unchanged.
function extractFileHeader(raw: string): { content: string; filename?: string } {
  const match = /^\s*\/\/\/\s*file:\s*([^\n\r]+?)\s*(\r?\n|$)/.exec(raw);
  if (!match) return { content: raw };
  return {
    content: raw.slice(match[0].length),
    filename: match[1].trim(),
  };
}

export interface RenderOptions {
  /// When provided, inline `<code>` tokens matching a `symbols[].pattern`
  /// are wrapped in a popover trigger (first occurrence per symbol only),
  /// and glossary terms are dotted-underlined on first use.
  enrichment?: LessonEnrichment;
}

export async function renderMarkdown(
  source: string,
  opts: RenderOptions = {},
): Promise<string> {
  // Step 1 — GitHub-style callout pre-processing on the raw markdown.
  // markdown-it's blockquote tokenizer would otherwise eat the [!NOTE]
  // line and leave us without enough signal to restyle the output.
  const withoutCallouts = transformCallouts(source);

  // Step 2 — let markdown-it render paragraphs, lists, tables, etc.
  const initial = md.render(withoutCallouts.md);

  // Step 3 — Shiki-highlight fenced code blocks (async).
  const afterHighlight = await replaceCodeFencePlaceholders(initial);

  // Step 4 — restore callout blocks (markdown-it wrapped them in
  // blockquote elements we marked with a placeholder sentinel).
  let joined = withoutCallouts.restore(afterHighlight);

  // Step 5 — post-process to weave in enrichment markers. Order matters:
  //   - symbols must run before terms so `Array.prototype.map` doesn't
  //     get its fragments underlined as if they were glossary terms.
  //   - both ignore text inside <code>, <pre>, and existing attributes.
  if (opts.enrichment?.symbols && opts.enrichment.symbols.length > 0) {
    joined = wrapSymbols(joined, opts.enrichment.symbols);
  }
  if (opts.enrichment?.glossary && opts.enrichment.glossary.length > 0) {
    joined = wrapGlossaryTerms(joined, opts.enrichment.glossary);
  }

  return joined;
}

// ---------- Callouts -------------------------------------------------------

/// Recognise GitHub-style callouts at the line level BEFORE markdown-it
/// tokenises the source. We detect the pattern:
///
///   > [!NOTE]
///   > optional body lines...
///
/// and replace the block with a sentinel marker. The sentinel looks like
/// a paragraph of only the marker text (`__FISHBONES_CALLOUT_N__`) so
/// markdown-it leaves it alone. After render we restore the marker with
/// the styled callout HTML, which includes the ORIGINAL inner body run
/// back through a mini markdown render so inline code / links / emphasis
/// in the callout body still works.
function transformCallouts(src: string): {
  md: string;
  restore: (html: string) => string;
} {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  const stash: Array<{ kind: CalloutKind; bodyHtml: string }> = [];

  const kindRe = /^>\s*\[!(NOTE|WARNING|TIP|EXAMPLE)\]\s*$/i;

  let i = 0;
  while (i < lines.length) {
    const header = kindRe.exec(lines[i]);
    if (!header) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const kind = header[1].toLowerCase() as CalloutKind;
    // Collect the body — every following `>`-prefixed line until a
    // non-`>` or EOF.
    i++;
    const bodyLines: string[] = [];
    while (i < lines.length && /^\s*>/.test(lines[i])) {
      bodyLines.push(lines[i].replace(/^\s*>\s?/, ""));
      i++;
    }
    // Render the body as its own markdown fragment so `code`, **bold**,
    // links, etc. work inside callouts.
    const bodyHtml = md.render(bodyLines.join("\n"));
    stash.push({ kind, bodyHtml });
    // Emit a sentinel that markdown-it preserves as a literal paragraph.
    // IMPORTANT: do NOT wrap the token in `__...__` — CommonMark parses
    // that as bold emphasis (`<strong>FISHBONES_CALLOUT_0</strong>`), so
    // the restore regex never matches and the literal token leaks visibly
    // into the rendered HTML. Bare letters + digits + a single-letter
    // boundary at each end survive markdown processing untouched.
    out.push("");
    out.push(`FISHBONESCALLOUTX${stash.length - 1}X`);
    out.push("");
  }

  return {
    md: out.join("\n"),
    restore: (html: string) => {
      return html.replace(
        /<p>FISHBONESCALLOUTX(\d+)X<\/p>/g,
        (_m, n: string) => {
          const entry = stash[parseInt(n, 10)];
          if (!entry) return "";
          return renderCalloutBlock(entry.kind, entry.bodyHtml);
        },
      );
    },
  };
}

type CalloutKind = "note" | "warning" | "tip" | "example";

const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: "Note",
  warning: "Warning",
  tip: "Tip",
  example: "Example",
};

/// Pre-built SVG strings matching the Icon primitive's output, inlined so the
/// callout glyph survives every re-render of `<div dangerouslySetInnerHTML>`.
/// Earlier attempts to hydrate a placeholder span from LessonReader were
/// fragile: any enrichment/progress re-render could clobber the injected
/// <svg>. Shipping the SVG in the initial HTML removes the race entirely.
const CALLOUT_GLYPH_SVG: Record<CalloutKind, string> = {
  note: wrapIconSvg(infoIcon),
  warning: wrapIconSvg(triangleAlert),
  tip: wrapIconSvg(lightbulb),
  example: wrapIconSvg(flaskConical),
};

function wrapIconSvg(inner: string): string {
  return (
    `<svg class="icon icon--xs" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  );
}

function renderCalloutBlock(kind: CalloutKind, bodyHtml: string): string {
  const label = CALLOUT_LABELS[kind];
  return (
    `<div class="fishbones-callout fishbones-callout--${kind}">` +
    `<div class="fishbones-callout-head">` +
    `<span class="fishbones-callout-glyph" aria-hidden="true">${CALLOUT_GLYPH_SVG[kind]}</span>` +
    `<span class="fishbones-callout-label">${escapeHtml(label)}</span>` +
    `</div>` +
    `<div class="fishbones-callout-body">${bodyHtml}</div>` +
    `</div>`
  );
}

// ---------- Fenced code blocks --------------------------------------------

async function replaceCodeFencePlaceholders(html: string): Promise<string> {
  // Filename attr is optional — the regex makes the whole `data-
  // fishbones-filename="…"` group optional with a `?`. Without that
  // optionality, fences without a `/// file:` header would skip the
  // placeholder pass entirely and render as raw `<pre>` with the
  // pending class.
  const placeholderRe =
    /<pre class="fishbones-code-pending" data-fishbones-lang="([^"]*)" data-fishbones-src="([^"]*)"(?: data-fishbones-filename="([^"]*)")?><\/pre>/g;

  const chunks: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const jobs: Array<Promise<string>> = [];
  while ((match = placeholderRe.exec(html)) !== null) {
    chunks.push(html.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;

    const lang = match[1];
    const b64 = match[2];
    const filename = match[3] ? decodeAttr(match[3]) : undefined;
    const code = decodeB64(b64);
    jobs.push(highlightCode(code, lang, filename));
    chunks.push(`__FISHBONES_CODE_${jobs.length - 1}__`);
  }
  chunks.push(html.slice(lastIndex));

  const highlighted = await Promise.all(jobs);
  let joined = chunks.join("");
  for (let i = 0; i < highlighted.length; i++) {
    joined = joined.replace(`__FISHBONES_CODE_${i}__`, highlighted[i]);
  }
  return joined;
}

async function highlightCode(
  code: string,
  lang: string,
  filename?: string,
): Promise<string> {
  const trimmed = normalizeCodeBlock(code);
  // The "Ask Fishbones" badge dispatches a `fishbones:ask-ai` custom
  // event when clicked — the AiAssistant root listener picks it up,
  // opens the panel, and sends a pre-formed prompt referencing this
  // exact snippet. Source is base64-encoded so it survives HTML
  // attribute quoting; the listener decodes once on activation.
  const b64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(trimmed)))
    : Buffer.from(trimmed, "utf-8").toString("base64");
  const askBadge = `<button class="fishbones-code-block-ask" type="button" data-fishbones-ask-code="${escapeAttr(b64)}" data-fishbones-ask-lang="${escapeAttr(lang)}" title="Discuss this code with the local assistant" aria-label="Ask Fishbones about this code">?</button>`;
  // Filename strip — small chrome above the code that surfaces the
  // tutorial's `/// file: NAME` header without polluting the syntax-
  // highlighted body. We also tag the wrapper div with
  // `--with-filename` so CSS can adjust the inner radius / spacing.
  const filenameStrip = filename
    ? `<div class="fishbones-code-filename"><span>${escapeHtml(filename)}</span></div>`
    : "";
  const wrapperClass = filename
    ? "fishbones-code-block fishbones-code-block--with-filename"
    : "fishbones-code-block";
  try {
    const inner = await codeToHtml(trimmed, { lang, theme: SHIKI_THEME });
    return `<div class="${wrapperClass}">${filenameStrip}${askBadge}${inner}</div>`;
  } catch {
    return `<div class="${wrapperClass}">${filenameStrip}${askBadge}<pre class="fishbones-code-plain">${escapeHtml(trimmed)}</pre></div>`;
  }
}

/// Normalise a fenced-code payload before highlighting:
///   - Drop leading + trailing blank lines.
///   - Dedent: find the minimum leading-whitespace count across every
///     non-empty line, and strip that from EVERY line. Preserves relative
///     indentation (nested braces / blocks stay aligned) while getting
///     rid of the ubiquitous "first character is a space" artifact that
///     comes from markdown-it handing us fences that were indented inside
///     lists, or from LLM outputs that accidentally included a leading
///     space on every block.
///
/// Empty input returns empty string (caller's try/catch handles the
/// "unknown language" fallback path).
function normalizeCodeBlock(code: string): string {
  const lines = code.split(/\r?\n/);
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) return "";

  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue; // blank lines don't set the floor
    const match = /^[ \t]*/.exec(line);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity || minIndent === 0) return lines.join("\n");
  return lines
    .map((l) => (l.length >= minIndent ? l.slice(minIndent) : l))
    .join("\n");
}

// ---------- Enrichment weaving --------------------------------------------

/// Walks the rendered HTML and wraps the FIRST inline `<code>` whose
/// text matches each symbol's `pattern` with a popover trigger. Skips
/// anything inside `<pre>` / `<code>` nesting levels > 1 so we don't
/// annotate code block contents (those have their own highlighting).
function wrapSymbols(html: string, symbols: SymbolEntry[]): string {
  if (symbols.length === 0) return html;

  // Map pattern → index for O(1) lookups during the text walk.
  const bySymbolText = new Map<string, SymbolEntry>();
  for (const s of symbols) {
    if (s.pattern && !bySymbolText.has(s.pattern)) {
      bySymbolText.set(s.pattern, s);
    }
  }

  // We match `<code>X</code>` that isn't already wrapped. The negative
  // lookbehind excludes matches inside Shiki-rendered code blocks
  // (which never render as bare `<code>` tokens — those are `<pre>
  // <code>...</code></pre>` and we explicitly skip those below).
  const seen = new Set<string>();
  return html.replace(
    /<code>([^<]+)<\/code>/g,
    (full, inner: string) => {
      // Keep the existing <code> element when no symbol matches — the
      // prose rendering of inline code (mono font, tertiary bg) still
      // happens via the CSS rule on .fishbones-reader-body code.
      const sym = bySymbolText.get(inner);
      if (!sym) return full;
      if (seen.has(inner)) return full; // first-occurrence-only
      seen.add(inner);
      const pattern = escapeAttr(inner);
      return (
        `<code class="fishbones-inline-symbol" data-pattern="${pattern}">${escapeHtml(inner)}</code>`
      );
    },
  );
}

/// Wrap the first occurrence of each glossary term in the rendered HTML
/// with a dotted-underline span. Skips any text inside <code>, <pre>,
/// or existing fishbones-* spans so we never annotate already-annotated
/// content. Case-sensitive (matches how the LLM is told to emit terms
/// exactly as they appear).
function wrapGlossaryTerms(html: string, glossary: GlossaryEntry[]): string {
  if (glossary.length === 0) return html;
  const terms = glossary
    .filter((g) => g.term && g.term.trim().length > 0)
    .sort((a, b) => b.term.length - a.term.length); // longest-first so nested phrases win

  // Split HTML into token runs of "text" and "tag" so we only rewrite
  // the text runs. Much safer than regex-on-attributes.
  const seen = new Set<string>();
  const parts: string[] = [];
  let i = 0;
  let inSkipTag = 0; // depth counter for <code>, <pre>, <a>, and annotated spans
  const skipOpenRe = /^<(code|pre|a)(\s|>)/i;
  const skipCloseRe = /^<\/(code|pre|a)>/i;
  const skipAnnotatedOpenRe = /^<(code|span) class="fishbones-(inline-symbol|inline-term)/i;
  const skipAnnotatedCloseRe = /^<\/(code|span)>/i;

  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close < 0) {
        parts.push(html.slice(i));
        break;
      }
      const tag = html.slice(i, close + 1);
      // Track whether we're inside something that should NOT be rewritten.
      if (skipAnnotatedOpenRe.test(tag)) {
        inSkipTag++;
      } else if (skipOpenRe.test(tag)) {
        inSkipTag++;
      } else if (skipAnnotatedCloseRe.test(tag) || skipCloseRe.test(tag)) {
        if (inSkipTag > 0) inSkipTag--;
      }
      parts.push(tag);
      i = close + 1;
      continue;
    }
    // Text run.
    const next = html.indexOf("<", i);
    const text = html.slice(i, next < 0 ? html.length : next);
    if (inSkipTag === 0) {
      parts.push(rewriteTextForTerms(text, terms, seen));
    } else {
      parts.push(text);
    }
    i = next < 0 ? html.length : next;
  }
  return parts.join("");
}

function rewriteTextForTerms(
  text: string,
  terms: GlossaryEntry[],
  seen: Set<string>,
): string {
  let out = text;
  for (const t of terms) {
    if (seen.has(t.term)) continue;
    // Word-boundary match for single words, exact phrase match for multi.
    const escaped = escapeForRegex(t.term);
    const wordBoundary = /^[A-Za-z0-9_]+$/.test(t.term) ? "\\b" : "";
    const re = new RegExp(`${wordBoundary}(${escaped})${wordBoundary}`);
    const match = re.exec(out);
    if (!match) continue;
    const start = match.index;
    const end = start + match[0].length;
    out =
      out.slice(0, start) +
      `<span class="fishbones-inline-term" data-term="${escapeAttr(t.term)}">${escapeHtml(match[0])}</span>` +
      out.slice(end);
    seen.add(t.term);
  }
  return out;
}

// ---------- Helpers -------------------------------------------------------

function decodeB64(b64: string): string {
  return typeof atob === "function"
    ? decodeURIComponent(escape(atob(b64)))
    : Buffer.from(b64, "base64").toString("utf-8");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/// Inverse of `escapeAttr` — decodes the four entities we encode on
/// the way IN. Lets the placeholder pass recover original filenames
/// (which can contain `&` / `<` / etc., though in practice they rarely
/// do) before re-escaping for the rendered filename strip.
function decodeAttr(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
