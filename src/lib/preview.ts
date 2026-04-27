/// Render a generated preview HTML string into something an `<iframe>`
/// can load.
///
/// Desktop: hand the HTML to the Tauri-hosted preview server which
/// returns a 127.0.0.1 URL. The server resolves `/vendor/*` against
/// `src-tauri/resources/vendor/`, so the iframe origin and the
/// vendor-asset paths line up cleanly.
///
/// Web: there's no preview server. We can't just use a blob: URL
/// directly because the iframe gets an opaque origin and relative
/// `/vendor/X` URLs inside the document fail to resolve. Two fixes
/// applied here:
///   1. Rewrite every `/vendor/<file>` reference in the HTML to the
///      absolute origin-prefixed URL (so the page can fetch them
///      from the Cloudflare Pages deploy regardless of iframe
///      origin).
///   2. Same treatment for `/starter-courses/*` etc. if they ever
///      appear inside generated HTML — currently they don't, but
///      the helper centralises the rewrite so future runtimes don't
///      have to reinvent it.

import { invoke } from "@tauri-apps/api/core";
import { isWeb } from "./platform";

/// Compute the absolute origin-prefixed root for the active web
/// build. Combines `window.location.origin` with Vite's
/// `import.meta.env.BASE_URL` (e.g. `/fishbones/learn/`) so the
/// returned string is the same root that served `index.html`.
///
/// e.g. when deployed:    `https://mattssoftware.com/fishbones/learn`
///      when dev:         `http://localhost:1420`
function webRootUrl(): string {
  if (typeof window === "undefined") return "";
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${window.location.origin}${base}`;
}

/// Rewrite every absolute `/vendor/X` reference in the HTML to the
/// origin-prefixed equivalent. Used by web builds whose generated
/// HTML is served via blob:// (opaque origin where relative URLs
/// don't resolve to the parent page).
function rewriteVendorUrls(html: string, root: string): string {
  return html.replace(/(["'(\s])\/vendor\//g, `$1${root}/vendor/`);
}

/// Convert a generated HTML string into a URL the iframe can load.
/// Returns `undefined` on failure so callers can fall back to a
/// "logs-only" RunResult — every existing call site already
/// tolerates the undefined path.
export async function presentPreview(html: string): Promise<string | undefined> {
  if (!isWeb) {
    try {
      const handle = await invoke<{ url: string }>("serve_web_preview", {
        html,
      });
      return handle.url;
    } catch {
      return undefined;
    }
  }
  // Web path — rewrite vendor URLs, then make a blob URL.
  try {
    const root = webRootUrl();
    const rewritten = rewriteVendorUrls(html, root);
    const blob = new Blob([rewritten], { type: "text/html" });
    return URL.createObjectURL(blob);
    // Note: we never URL.revokeObjectURL — the iframe holds the URL
    // for the lifetime of the run, and a few unrevoked objects per
    // run is fine for a single-page app. Tauri does its own cleanup
    // server-side; web users navigating away tears the whole thing
    // down anyway.
  } catch {
    return undefined;
  }
}
