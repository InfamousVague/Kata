import { languageMeta } from "../../lib/languages";
import "./LanguageChip.css";

/// Branded language chip — language icon + (optional) label, sat in a
/// rounded pill tinted with the language's brand colour.
///
/// Pulls all visual data from `LANGUAGE_META` so any surface that needs
/// "this is a Python course" / "this tab is Rust" / etc. can drop one
/// in without restating the colour or icon. Three sizes:
///
///   - `xs`: 16px-tall, icon-only by default. Used in places where space
///     is tight (sidebar course rows, very small tab pills).
///   - `sm`: 20px-tall. The everyday size — top-bar tabs, profile grid,
///     library cards' corner chip.
///   - `md`: 26px-tall. Page-header / hero contexts.
///
/// All sizes default to `iconOnly: false` (icon + label). Pass
/// `iconOnly` to drop the label.
///
/// Background is `color-mix(in srgb, <brand> 12%, transparent)` —
/// keeps the surrounding card colour visible underneath, so the chip
/// reads as a tag rather than a button. Text + icon stay full-strength
/// brand colour for contrast.

interface Props {
  /// Lowercased language id (`"python"`, `"rust"`, etc.). Anything not
  /// in `LANGUAGE_META` falls through to the neutral grey "Code" chip
  /// — that way legacy course data with a typo doesn't crash.
  language: string;
  /// Display size. Defaults to `sm`. See module comment for spec.
  size?: "xs" | "sm" | "md";
  /// Hide the label, leaving just the icon. Defaults to `true` for the
  /// `xs` size (label would be unreadable at that scale anyway), `false`
  /// otherwise. Pass explicitly to override.
  iconOnly?: boolean;
  /// Optional className for additional layout (e.g. self-positioning
  /// inside a parent grid). Doesn't override the chip's own visual
  /// treatment.
  className?: string;
  /// Optional title-tooltip override. Defaults to the language label
  /// for screen readers + hover hints.
  title?: string;
}

export default function LanguageChip({
  language,
  size = "sm",
  iconOnly,
  className,
  title,
}: Props) {
  const meta = languageMeta(language);
  const labelHidden = iconOnly ?? size === "xs";
  const Icon = meta.Icon;

  return (
    <span
      className={`fishbones-langchip fishbones-langchip--${size} ${
        labelHidden ? "fishbones-langchip--icon-only" : ""
      } ${className ?? ""}`}
      // Chip background reads the brand colour at 12% opacity so the
      // surrounding card colour shows through. Text + icon use the
      // full brand colour for contrast.
      style={{
        // CSS custom properties lets the .css apply the colour in
        // multiple places (background, text, hover) without us having
        // to inline every property here.
        ["--langchip-color" as string]: meta.color,
      }}
      title={title ?? meta.label}
      aria-label={meta.label}
    >
      <span className="fishbones-langchip-icon" aria-hidden>
        <Icon />
      </span>
      {!labelHidden && (
        <span className="fishbones-langchip-label">{meta.label}</span>
      )}
    </span>
  );
}
