import { useEffect, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { flame } from "@base/primitives/icon/icons/flame";
import { check } from "@base/primitives/icon/icons/check";
import { sparkles } from "@base/primitives/icon/icons/sparkles";
import { trophy } from "@base/primitives/icon/icons/trophy";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import { panelLeftClose } from "@base/primitives/icon/icons/panel-left-close";
import { panelLeftOpen } from "@base/primitives/icon/icons/panel-left-open";
import "@base/primitives/icon/icon.css";
import type { StreakAndXp } from "../../hooks/useStreakAndXp";
import { ProgressRing } from "../Shared/ProgressRing";
import LanguageChip from "../LanguageChip/LanguageChip";
import { isWeb } from "../../lib/platform";
import "./TopBar.css";

/// Semantic color tokens for the stats chips. Each row's uppercase label
/// is tinted to match its icon so the eye pairs them at a glance.
const STAT_COLORS = {
  streak: "#ff9b5e",   // warm orange — fire
  lessons: "#7cd97c",  // success green
  xp: "#e8c46b",       // warm gold
  longest: "#c79bff",  // soft purple — personal-record accent
} as const;

export interface Tab {
  id: string;
  label: string;
  language: string;
}

interface Props {
  tabs: Tab[];
  activeIndex: number;
  onActivate: (index: number) => void;
  onClose: (index: number) => void;
  /// Learner's current streak + XP. Combined into a single trigger chip
  /// in the top bar — click to expand a detail dropdown. The chip is
  /// always rendered (even at level 1 / 0 streak) because the dropdown
  /// is also where unauthenticated learners pick up the cloud-sync
  /// sign-in CTA — hiding it would orphan that path.
  stats?: StreakAndXp;
  /// Called when the "View Profile" button at the bottom of the stats
  /// dropdown is clicked. Routes the main pane to the Profile view.
  onOpenProfile?: () => void;
  /// Whether the sidebar is currently collapsed. Drives the toggle
  /// button's icon so it always shows the *action* the click will
  /// perform (show panel when collapsed, hide panel when expanded).
  sidebarCollapsed?: boolean;
  /// Toggles sidebar visibility. Also mapped to Cmd/Ctrl+\ at the app
  /// level, but the button gives learners an obvious, discoverable path.
  onToggleSidebar?: () => void;

  /// Cloud-sync auth state, surfaced in the dropdown's account row.
  /// `signedIn=false` shows a "Sign in" button next to "View profile";
  /// `signedIn=true` shows the user identity + a "Sign out" link.
  /// Pass `undefined` (or omit) to hide the account row entirely —
  /// useful for embeds / non-Tauri builds where cloud isn't wired.
  signedIn?: boolean;
  userDisplayName?: string | null;
  userEmail?: string | null;
  /// Opens the sign-in modal. Only invoked when `signedIn === false`.
  onSignIn?: () => void;
  /// Best-effort logout (revokes the token server-side and clears local
  /// cache). Errors are swallowed in the hook; the chip just goes back
  /// to the signed-out state.
  onSignOut?: () => void;
}

/// Custom window top bar. The window is configured with
/// `titleBarStyle: "Overlay"` so the macOS traffic lights float over this bar
/// at the top-left. The bar doubles as a drag region via
/// `data-tauri-drag-region`. Individual clickable elements cancel drag by
/// NOT setting the attribute on themselves.
export default function TopBar({
  tabs,
  activeIndex,
  onActivate,
  onClose,
  stats,
  onOpenProfile,
  sidebarCollapsed = false,
  onToggleSidebar,
  signedIn,
  userDisplayName,
  userEmail,
  onSignIn,
  onSignOut,
}: Props) {
  // Always show the chip when stats are wired — the dropdown carries
  // both the level/streak detail and the cloud-sync sign-in path, so
  // hiding it for fresh learners would orphan the latter.
  const showStats = !!stats;

  return (
    <div className="fishbones__topbar" data-tauri-drag-region>
      {/* On desktop: reserved gutter so the macOS traffic lights
          (which `titleBarStyle: "Overlay"` floats over the bar at
          x≈18) don't collide with the sidebar toggle. On web:
          there are no traffic lights, so we use the same width
          for a brand element — Fishbones logo + wordmark — that
          links back to the marketing site one path-segment up. */}
      {isWeb ? (
        <a
          href="../"
          className="fishbones__topbar-brand"
          aria-label="Fishbones Academy home"
          data-tauri-drag-region={false}
        >
          {/* Match the marketing-site nav: skinny fish-skeleton
              wordmark followed by the `.academy` TLD. Same asset
              ships at fishbones.academy/fishbones_skinny_white.png
              and inside the embedded /learn/ build. */}
          <img
            src={`${import.meta.env.BASE_URL}fishbones_skinny_white.png`}
            alt="Fishbones"
            className="fishbones__topbar-brand-icon"
          />
          <span className="fishbones__topbar-brand-tld">.academy</span>
        </a>
      ) : (
        <div className="fishbones__topbar-window-controls" data-tauri-drag-region />
      )}

      {onToggleSidebar && (
        <button
          type="button"
          className="fishbones__topbar-sidebar-toggle"
          onClick={onToggleSidebar}
          title={
            sidebarCollapsed
              ? "Show sidebar (⌘\\)"
              : "Hide sidebar (⌘\\)"
          }
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-pressed={sidebarCollapsed}
        >
          <Icon
            icon={sidebarCollapsed ? panelLeftOpen : panelLeftClose}
            size="sm"
            color="currentColor"
          />
        </button>
      )}

      <div className="fishbones__topbar-tabs" data-tauri-drag-region>
        {tabs.length > 0 && (
          <span className="fishbones__topbar-tabs-label" aria-hidden>
            Recents
          </span>
        )}
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            className={`fishbones__tab ${i === activeIndex ? "fishbones__tab--active" : ""}`}
            onClick={() => onActivate(i)}
          >
            <LanguageChip
              language={tab.language}
              size="xs"
              iconOnly
              className="fishbones__tab-lang"
            />
            <span className="fishbones__tab-label">{tab.label}</span>
            <span
              className="fishbones__tab-close"
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(i);
              }}
            >
              <Icon icon={xIcon} size="xs" color="currentColor" />
            </span>
          </button>
        ))}
      </div>

      <div className="fishbones__topbar-actions">
        {showStats && (
          <StatsChip
            stats={stats!}
            onOpenProfile={onOpenProfile}
            signedIn={signedIn}
            userDisplayName={userDisplayName}
            userEmail={userEmail}
            onSignIn={onSignIn}
            onSignOut={onSignOut}
          />
        )}
      </div>
    </div>
  );
}

/// Combined streak + level chip with a dropdown detail panel. Chip shows
/// streak flame + a small circular progress ring whose fill is XP-into-
/// current-level. Clicking expands a panel with the full numbers AND the
/// account row (sign-in / sign-out).
function StatsChip({
  stats,
  onOpenProfile,
  signedIn,
  userDisplayName,
  userEmail,
  onSignIn,
  onSignOut,
}: {
  stats: StreakAndXp;
  onOpenProfile?: () => void;
  signedIn?: boolean;
  userDisplayName?: string | null;
  userEmail?: string | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Click-outside + escape dismissal.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const levelProgress =
    stats.xpForLevel > 0 ? stats.xpIntoLevel / stats.xpForLevel : 0;
  const streakActive = stats.streakDays >= 1;
  const xpToNext = Math.max(0, stats.xpForLevel - stats.xpIntoLevel);

  return (
    <div
      className="fishbones__topbar-stats-wrap"
      ref={wrapRef}
      data-tauri-drag-region={false}
    >
      <button
        className={`fishbones__topbar-stats-trigger ${
          open ? "fishbones__topbar-stats-trigger--open" : ""
        }`}
        onClick={() => setOpen((v) => !v)}
        title={`Level ${stats.level} · ${stats.streakDays} day streak`}
      >
        <span
          className={`fishbones__topbar-streak ${
            streakActive ? "fishbones__topbar-streak--active" : ""
          }`}
        >
          <span className="fishbones__topbar-streak-flame" aria-hidden>
            <Icon icon={flame} size="xs" color="currentColor" weight="bold" />
          </span>
          <span className="fishbones__topbar-streak-count">{stats.streakDays}</span>
        </span>
        <ProgressRing
          progress={levelProgress}
          size={22}
          stroke={2.5}
          label={String(stats.level)}
        />
      </button>

      {open && (
        <div className="fishbones__topbar-stats-panel" role="dialog" aria-label="Progress stats">
          {/* Hero row. The ring's centre already shows the level
              number, so the right-hand body promotes the SIGNED-IN
              identity (name + email) instead of duplicating "Level N"
              as a heading. When the learner is signed out, we fall
              back to a plain Level heading so the row still has
              something to anchor against the ring. */}
          <div className="fishbones__topbar-stats-hero">
            <ProgressRing
              progress={levelProgress}
              size={72}
              stroke={5}
              label={String(stats.level)}
              sublabel="level"
            />
            <div className="fishbones__topbar-stats-hero-body">
              {signedIn === true && (userDisplayName?.trim() || userEmail) ? (
                <>
                  <div className="fishbones__topbar-stats-heading">
                    {userDisplayName?.trim() || userEmail}
                  </div>
                  {userEmail && userDisplayName?.trim() && (
                    <div className="fishbones__topbar-stats-sub">{userEmail}</div>
                  )}
                </>
              ) : (
                <>
                  <div className="fishbones__topbar-stats-heading">Level {stats.level}</div>
                  <div className="fishbones__topbar-stats-sub">
                    {stats.xpIntoLevel} / {stats.xpForLevel} XP
                  </div>
                </>
              )}
              <div className="fishbones__topbar-stats-to-next">
                {xpToNext === 0
                  ? "Ready to level up — complete any lesson!"
                  : `${xpToNext} XP to level ${stats.level + 1}`}
              </div>
            </div>
          </div>

          <div className="fishbones__topbar-stats-divider" aria-hidden />

          <div className="fishbones__topbar-stats-grid">
            <StatBlock
              icon={flame}
              color={STAT_COLORS.streak}
              label={streakActive ? "Current streak" : "Streak"}
              value={`${stats.streakDays} ${stats.streakDays === 1 ? "day" : "days"}`}
              hint={
                stats.longestStreakDays > stats.streakDays
                  ? `best · ${stats.longestStreakDays} days`
                  : streakActive
                  ? "keep it going"
                  : "complete a lesson today to start"
              }
            />
            <StatBlock
              icon={check}
              color={STAT_COLORS.lessons}
              label="Lessons done"
              value={String(stats.lessonsCompleted)}
              hint="across all courses"
            />
            <StatBlock
              icon={sparkles}
              color={STAT_COLORS.xp}
              label="Total XP"
              value={String(stats.xp)}
              hint="5 reading · 10 quiz · 20 exercise"
            />
            <StatBlock
              icon={trophy}
              color={STAT_COLORS.longest}
              label="Longest streak"
              value={`${stats.longestStreakDays} ${
                stats.longestStreakDays === 1 ? "day" : "days"
              }`}
              hint="personal record"
            />
          </div>

          {/* Account row + View-profile CTA, anchored to the bottom of
              the popup. When the learner is signed out, "Sign in"
              becomes the primary call-to-action and "View profile"
              steps down to a secondary outline; when they're signed in,
              the identity + a quiet "Sign out" link replaces the row
              and "View profile" goes back to primary. */}
          {signedIn === false && onSignIn && (
            <div className="fishbones__topbar-stats-account">
              <div className="fishbones__topbar-stats-account-row">
                <button
                  type="button"
                  className="fishbones__topbar-stats-signin"
                  onClick={() => {
                    setOpen(false);
                    onSignIn();
                  }}
                >
                  Sign in
                </button>
                {onOpenProfile && (
                  <button
                    type="button"
                    className="fishbones__topbar-stats-view-profile fishbones__topbar-stats-view-profile--secondary"
                    onClick={() => {
                      setOpen(false);
                      onOpenProfile();
                    }}
                  >
                    View profile
                  </button>
                )}
              </div>
            </div>
          )}

          {signedIn === true && (
            <div className="fishbones__topbar-stats-account">
              {/* Identity card removed from this row — the hero block
                  above promotes name + email next to the level ring,
                  so duplicating it here was just visual noise. */}
              <div className="fishbones__topbar-stats-account-row">
                {onOpenProfile && (
                  <button
                    type="button"
                    className="fishbones__topbar-stats-view-profile"
                    onClick={() => {
                      setOpen(false);
                      onOpenProfile();
                    }}
                  >
                    View profile
                  </button>
                )}
                {onSignOut && (
                  <button
                    type="button"
                    className="fishbones__topbar-stats-signout"
                    onClick={() => {
                      setOpen(false);
                      onSignOut();
                    }}
                  >
                    Sign out
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Fallback for embeds that don't wire `signedIn` at all —
              keeps the old single-CTA shape so non-Tauri builds aren't
              broken. */}
          {signedIn === undefined && onOpenProfile && (
            <button
              type="button"
              className="fishbones__topbar-stats-view-profile"
              onClick={() => {
                setOpen(false);
                onOpenProfile();
              }}
            >
              View profile
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StatBlock({
  icon,
  color,
  label,
  value,
  hint,
}: {
  icon: string;
  /// Hex color used for BOTH the icon and the uppercase label text so the
  /// visual pairing is obvious. The big value + hint stay in their
  /// neutral token colors so rows don't become overwhelming.
  color: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="fishbones__topbar-stats-block">
      <div className="fishbones__topbar-stats-block-label" style={{ color }}>
        <span className="fishbones__topbar-stats-block-icon" aria-hidden>
          <Icon icon={icon} size="xs" color="currentColor" weight="bold" />
        </span>
        {label}
      </div>
      <div className="fishbones__topbar-stats-block-value">{value}</div>
      <div className="fishbones__topbar-stats-block-hint">{hint}</div>
    </div>
  );
}

