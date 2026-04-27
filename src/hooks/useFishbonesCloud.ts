import { useCallback, useEffect, useMemo, useState } from "react";

/// Optional cloud-sync hook for the Fishbones relay.
///
/// All sync is opt-in. When the user hasn't signed in we behave
/// exactly like before — local SQLite + JSON only — so the app stays
/// fully usable without a network round-trip on every interaction.
///
/// State machine:
///   - bootstrap from localStorage (relay URL, token, cached user)
///   - calling `signIn*()` writes the token + user to localStorage
///   - signOut() clears everything (token revoked server-side too)
///   - `pushProgress` / `pullProgress` are no-ops without a token
///
/// The relay URL defaults to a sensible production endpoint but can
/// be overridden via the `FISHBONES_RELAY_URL` Vite-time env var or
/// localStorage so test deploys can point at a staging host.

const TOKEN_KEY = "fishbones:cloud:token-v1";
const USER_KEY = "fishbones:cloud:user-v1";
const URL_OVERRIDE_KEY = "fishbones:cloud:url-override-v1";

const DEFAULT_RELAY_URL = "https://api.mattssoftware.com";

export interface FishbonesCloudUser {
  id: string;
  email: string | null;
  display_name: string | null;
  has_password: boolean;
  apple_linked: boolean;
  google_linked: boolean;
}

export interface ProgressRow {
  course_id: string;
  lesson_id: string;
  /// ISO 8601 timestamp.
  completed_at: string;
}

export interface CourseMeta {
  id: string;
  course_slug: string;
  owner_id: string;
  owner_display_name: string | null;
  title: string;
  description: string | null;
  language: string | null;
  visibility: "private" | "unlisted" | "public";
  archive_size: number;
  created_at: string;
  updated_at: string;
}

export interface UseFishbonesCloud {
  /// Effective relay base URL (env override → localStorage → default).
  relayUrl: string;
  /// Persistent overrides for tests + staging deploys.
  setRelayUrlOverride: (url: string | null) => void;
  /// `null` while booting, `false` when there's no stored token,
  /// the user object once the cached `me` fetch lands.
  user: FishbonesCloudUser | null | false;
  signedIn: boolean;
  /// In-flight indicator for any of the auth/sync operations.
  busy: boolean;
  /// Last error from any cloud op. Cleared at the start of each call.
  error: string | null;

  signUpEmail: (email: string, password: string, displayName?: string) => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  signInApple: (identityToken: string, displayName?: string) => Promise<void>;
  signInGoogle: (identityToken: string, displayName?: string) => Promise<void>;
  /// Adopt a token issued by the browser-OAuth relay flow (Apple SIWA
  /// or Google) without re-running the auth POST. The desktop deep-
  /// link handler calls this once it parses `fishbones://oauth/done`.
  /// Stores the token + clears the cached user so the existing
  /// `/me`-on-mount effect picks it up and populates the user object.
  applyOAuthToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;

  /// Pull every progress row the server has for this user. Returns
  /// the rows so the caller can merge them into local state.
  pullProgress: () => Promise<ProgressRow[]>;
  /// Push the local progress array as a bulk upsert. Server-side
  /// merge keeps the newer `completed_at` per (course, lesson).
  pushProgress: (rows: ProgressRow[]) => Promise<void>;

  /// Upload a `.fishbones` archive (Uint8Array) tagged with metadata.
  uploadCourse: (input: {
    courseSlug: string;
    title: string;
    description?: string;
    language?: string;
    visibility: "private" | "unlisted" | "public";
    archive: Uint8Array;
  }) => Promise<CourseMeta>;
  listMyCourses: () => Promise<CourseMeta[]>;
  listPublicCourses: () => Promise<CourseMeta[]>;
  /// Returns the raw archive bytes for `.fishbones` import.
  downloadCourse: (courseId: string) => Promise<ArrayBuffer>;
  deleteCourse: (courseId: string) => Promise<void>;
}

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}
function readUser(): FishbonesCloudUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) as FishbonesCloudUser : null;
  } catch { return null; }
}
function writeUser(u: FishbonesCloudUser | null): void {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch { /* private mode */ }
}
function readUrlOverride(): string | null {
  try { return localStorage.getItem(URL_OVERRIDE_KEY); } catch { return null; }
}

function envRelayUrl(): string {
  // Vite-time inline (build-time): VITE_FISHBONES_RELAY_URL. We try
  // the import.meta.env path first; fall back to the default if it's
  // not declared at build time.
  type EnvShape = { VITE_FISHBONES_RELAY_URL?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (import.meta as any).env as EnvShape | undefined;
  return env?.VITE_FISHBONES_RELAY_URL ?? DEFAULT_RELAY_URL;
}

export function useFishbonesCloud(): UseFishbonesCloud {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [user, setUser] = useState<FishbonesCloudUser | null | false>(() => {
    const cached = readUser();
    if (cached) return cached;
    return readToken() ? null : false;
  });
  const [urlOverride, setUrlOverride] = useState<string | null>(() => readUrlOverride());
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const relayUrl = (urlOverride || envRelayUrl()).replace(/\/$/, "");

  // Refresh `me` on first mount when we have a token but no cached
  // user object. Surfaces revoked tokens (`401`) by clearing local
  // state so the UI shows the sign-in prompt again.
  useEffect(() => {
    if (!token || user !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${relayUrl}/fishbones/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`me failed: ${res.status}`);
        const me = (await res.json()) as FishbonesCloudUser;
        if (cancelled) return;
        writeUser(me);
        setUser(me);
      } catch {
        if (cancelled) return;
        // Token bad — drop it.
        writeToken(null);
        writeUser(null);
        setToken(null);
        setUser(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, user, relayUrl]);

  const setRelayUrlOverride = useCallback((u: string | null) => {
    try {
      if (u) localStorage.setItem(URL_OVERRIDE_KEY, u);
      else localStorage.removeItem(URL_OVERRIDE_KEY);
    } catch { /* ignore */ }
    setUrlOverride(u);
  }, []);

  /// Run an auth call (signup/login/oauth). On success, persist token
  /// and user — every flow ends with the same `{ token, user }` JSON.
  const runAuth = useCallback(
    async (path: string, body: unknown): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${relayUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          // Surface a friendlier message for the common cases. The
          // server intentionally collapses bad-credential and unknown-
          // user into the same 401 to avoid email-existence leaks, so
          // the client can't distinguish them — display generically.
          const msg =
            res.status === 401
              ? "Email or password didn't match."
              : res.status === 409
                ? "An account with that email already exists."
                : res.status === 503
                  ? "That sign-in method isn't configured on the server."
                  : `Sign-in failed (${res.status}).`;
          throw new Error(msg);
        }
        const json = (await res.json()) as { token: string; user: FishbonesCloudUser };
        writeToken(json.token);
        writeUser(json.user);
        setToken(json.token);
        setUser(json.user);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [relayUrl],
  );

  const deviceLabel = (() => {
    // Cheap fingerprint for the token-list view server-side. Not a
    // security boundary; just a hint to the user (e.g. "MacBook Pro
    // · macOS"). Falls back to a generic label off the navigator UA.
    if (typeof navigator === "undefined") return "desktop";
    const ua = navigator.userAgent;
    if (ua.includes("Macintosh")) return "macOS desktop";
    if (ua.includes("Windows")) return "Windows desktop";
    if (ua.includes("Linux")) return "Linux desktop";
    return "desktop";
  })();

  const signUpEmail = useCallback(
    async (email: string, password: string, displayName?: string) => {
      await runAuth("/fishbones/auth/signup", {
        email,
        password,
        display_name: displayName,
        device_label: deviceLabel,
      });
    },
    [runAuth, deviceLabel],
  );
  const signInEmail = useCallback(
    async (email: string, password: string) => {
      await runAuth("/fishbones/auth/login", {
        email,
        password,
        device_label: deviceLabel,
      });
    },
    [runAuth, deviceLabel],
  );
  const signInApple = useCallback(
    async (identityToken: string, displayName?: string) => {
      await runAuth("/fishbones/auth/apple", {
        identity_token: identityToken,
        display_name: displayName,
        device_label: deviceLabel,
      });
    },
    [runAuth, deviceLabel],
  );
  const signInGoogle = useCallback(
    async (identityToken: string, displayName?: string) => {
      await runAuth("/fishbones/auth/google", {
        identity_token: identityToken,
        display_name: displayName,
        device_label: deviceLabel,
      });
    },
    [runAuth, deviceLabel],
  );

  /// Adopt a token from the browser-OAuth deep-link callback. The relay
  /// minted it server-side after exchanging the provider code, so we
  /// just need to persist it locally and let the `/me`-on-mount effect
  /// fetch the user record. Setting `user` to `null` (rather than
  /// `false`) is the trigger — the effect below watches `[token, user]`
  /// and only fires when `user === null`.
  const applyOAuthToken = useCallback(async (t: string) => {
    writeToken(t);
    writeUser(null);
    setToken(t);
    setUser(null);
  }, []);

  const signOut = useCallback(async () => {
    if (token) {
      // Best-effort revoke. Even if the request fails (offline,
      // expired token), we still clear local state — the user clicked
      // "sign out" and shouldn't be left stuck on the dashboard.
      await fetch(`${relayUrl}/fishbones/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    writeToken(null);
    writeUser(null);
    setToken(null);
    setUser(false);
  }, [token, relayUrl]);

  const deleteAccount = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${relayUrl}/fishbones/auth/account`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Delete failed (${res.status})`);
      }
      writeToken(null);
      writeUser(null);
      setToken(null);
      setUser(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [token, relayUrl]);

  const authFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      if (!token) throw new Error("Not signed in");
      const headers = new Headers(init.headers ?? {});
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      return fetch(`${relayUrl}${path}`, { ...init, headers });
    },
    [token, relayUrl],
  );

  const pullProgress = useCallback(async (): Promise<ProgressRow[]> => {
    const res = await authFetch("/fishbones/progress");
    if (!res.ok) throw new Error(`pull failed (${res.status})`);
    return (await res.json()) as ProgressRow[];
  }, [authFetch]);

  const pushProgress = useCallback(
    async (rows: ProgressRow[]) => {
      if (rows.length === 0) return;
      // Chunk in batches of 1000 — server caps at 5000 per request,
      // and smaller chunks make a partial-failure more recoverable.
      for (let i = 0; i < rows.length; i += 1000) {
        const slice = rows.slice(i, i + 1000);
        const res = await authFetch("/fishbones/progress", {
          method: "PUT",
          body: JSON.stringify({ rows: slice }),
        });
        if (!res.ok && res.status !== 204) {
          throw new Error(`push failed (${res.status})`);
        }
      }
    },
    [authFetch],
  );

  const uploadCourse = useCallback(
    async (input: {
      courseSlug: string;
      title: string;
      description?: string;
      language?: string;
      visibility: "private" | "unlisted" | "public";
      archive: Uint8Array;
    }): Promise<CourseMeta> => {
      // Convert Uint8Array → base64 in JS — the relay accepts it as a
      // string field to dodge multipart-CORS edge cases.
      let binary = "";
      for (let i = 0; i < input.archive.length; i++) {
        binary += String.fromCharCode(input.archive[i]);
      }
      const archive_b64 = btoa(binary);
      const res = await authFetch("/fishbones/courses", {
        method: "POST",
        body: JSON.stringify({
          course_slug: input.courseSlug,
          title: input.title,
          description: input.description,
          language: input.language,
          visibility: input.visibility,
          archive_b64,
        }),
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      return (await res.json()) as CourseMeta;
    },
    [authFetch],
  );

  const listMyCourses = useCallback(async (): Promise<CourseMeta[]> => {
    const res = await authFetch("/fishbones/courses");
    if (!res.ok) throw new Error(`list failed (${res.status})`);
    return (await res.json()) as CourseMeta[];
  }, [authFetch]);

  const listPublicCourses = useCallback(async (): Promise<CourseMeta[]> => {
    const res = await fetch(`${relayUrl}/fishbones/courses/public`);
    if (!res.ok) throw new Error(`list-public failed (${res.status})`);
    return (await res.json()) as CourseMeta[];
  }, [relayUrl]);

  const downloadCourse = useCallback(
    async (courseId: string): Promise<ArrayBuffer> => {
      const res = await authFetch(`/fishbones/courses/${encodeURIComponent(courseId)}`);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return await res.arrayBuffer();
    },
    [authFetch],
  );

  const deleteCourse = useCallback(
    async (courseId: string) => {
      const res = await authFetch(`/fishbones/courses/${encodeURIComponent(courseId)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`delete failed (${res.status})`);
      }
    },
    [authFetch],
  );

  // Memoise the return shape so the *object identity* is stable
  // unless something on it actually changed. Without this, every
  // render of the consumer (App.tsx) creates a new `cloud` reference,
  // and any effect that takes `cloud` as a dep re-runs every render.
  // For the deep-link `useEffect` that translated into a re-subscribe
  // + re-call of `getCurrentDeepLinks()` on every paint, which on
  // macOS sometimes re-delivered the OAuth callback URL — firing
  // applyOAuthToken repeatedly, which sets `user = null`, flipping
  // `signedIn` false, until `/me` re-resolves. Net effect: visible
  // auth-state flashing in any UI that reads `signedIn`. Memoising
  // here is the single fix that eliminates it.
  return useMemo(
    () => ({
      relayUrl,
      setRelayUrlOverride,
      user,
      // `user` is `false` when we know there's no session, `null`
      // while booting, or the user object when signed in.
      signedIn: typeof user === "object" && user !== null,
      busy,
      error,
      signUpEmail,
      signInEmail,
      signInApple,
      signInGoogle,
      applyOAuthToken,
      signOut,
      deleteAccount,
      pullProgress,
      pushProgress,
      uploadCourse,
      listMyCourses,
      listPublicCourses,
      downloadCourse,
      deleteCourse,
    }),
    [
      relayUrl,
      setRelayUrlOverride,
      user,
      busy,
      error,
      signUpEmail,
      signInEmail,
      signInApple,
      signInGoogle,
      applyOAuthToken,
      signOut,
      deleteAccount,
      pullProgress,
      pushProgress,
      uploadCourse,
      listMyCourses,
      listPublicCourses,
      downloadCourse,
      deleteCourse,
    ],
  );
}
