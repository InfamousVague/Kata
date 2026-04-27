/// Web-build stub for `@tauri-apps/plugin-deep-link`.
///
/// Deep links rely on the OS registering a custom scheme (`fishbones://`)
/// for the app — not a thing browsers do. The web build uses standard
/// HTTPS redirect URIs for OAuth instead (Phase 5 wires that up at the
/// `mattssoftware.com/play/oauth/done` route).
///
/// Both functions return shapes that the existing call sites already
/// handle gracefully (no URLs, no listeners), so App.tsx's deep-link
/// boot code degrades to a one-shot "nothing to handle" pass on web.

export type UnlistenFn = () => void;

export async function onOpenUrl(
  _handler: (urls: string[]) => void,
): Promise<UnlistenFn> {
  return () => {};
}

export async function getCurrent(): Promise<string[] | null> {
  return null;
}

export async function register(_protocol: string): Promise<null> {
  return null;
}

export async function unregister(_protocol: string): Promise<null> {
  return null;
}

export async function isRegistered(_protocol: string): Promise<boolean> {
  return false;
}
