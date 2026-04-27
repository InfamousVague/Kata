/// Web-build stub for `@tauri-apps/api/webviewWindow`.
///
/// Phone-popout (`src/lib/phonePopout.ts`) and workbench-popout
/// (`src/lib/workbenchSync.ts`) ALREADY detect Tauri-vs-web at
/// runtime and fall back to `window.open()` + BroadcastChannel — so
/// this stub doesn't have to do anything functional. It exists only
/// so Vite's dynamic-import resolver succeeds; the runtime path
/// inside those files never reaches this code on web because the
/// `isTauri()` check fails first.

export class WebviewWindow {
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(label: string, _options?: unknown) {
    this.label = label;
  }
  static getByLabel(_label: string): WebviewWindow | null {
    return null;
  }
  static getAll(): WebviewWindow[] {
    return [];
  }
  async close(): Promise<void> {}
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async setFocus(): Promise<void> {}
  async setTitle(_title: string): Promise<void> {}
  async listen<T>(
    _event: string,
    _handler: (e: { payload: T }) => void,
  ): Promise<() => void> {
    return () => {};
  }
  async emit(_event: string, _payload?: unknown): Promise<void> {}
  async once<T>(
    _event: string,
    _handler: (e: { payload: T }) => void,
  ): Promise<() => void> {
    return () => {};
  }
}

export function getCurrent(): WebviewWindow | null {
  return null;
}

export function getCurrentWebviewWindow(): WebviewWindow | null {
  return null;
}
