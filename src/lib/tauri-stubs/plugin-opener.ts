/// Web-build stub for `@tauri-apps/plugin-opener`.
///
/// On desktop the opener plugin shells out to the OS to launch URLs /
/// file paths in the user's default browser / file viewer. On web we
/// can't open arbitrary file paths, but URLs map cleanly to
/// `window.open(url, "_blank", ...)`. Anything else (file paths) is
/// out of scope for the web build.

export async function openUrl(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  // _blank + noopener for safety — same defaults the desktop opener
  // gives us when launching a URL externally.
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openPath(_path: string): Promise<void> {
  // No-op on web. Caller should be using openUrl for any web-relevant
  // case.
}

export async function revealItemInDir(_path: string): Promise<void> {
  // No-op on web.
}
