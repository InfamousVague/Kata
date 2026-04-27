/// Web-build stub for `@tauri-apps/api/event`.
///
/// Listeners attach to a no-op so callers' cleanup code (returning
/// `unlisten()` from useEffect, etc.) keeps working unchanged. No
/// events ever fire — on web there's no Tauri IPC bus. Code that
/// genuinely needs cross-window messaging on web should use
/// BroadcastChannel directly (see `src/lib/workbenchSync.ts` for the
/// existing dual-path pattern).

export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  windowLabel?: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

export async function listen<T>(
  _event: string,
  _handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return () => {};
}

export async function once<T>(
  _event: string,
  _handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return () => {};
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {
  // No-op. There's no event bus to emit to on web.
}

export async function emitTo(
  _target: string,
  _event: string,
  _payload?: unknown,
): Promise<void> {
  // No-op.
}
