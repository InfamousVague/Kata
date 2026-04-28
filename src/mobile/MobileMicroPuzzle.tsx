/// Mobile micro-puzzle renderer — wordbank pattern.
///
/// One card at a time fills the lesson area: the code block sits at
/// top with empty inline slots, and a sticky bottom panel shows a
/// pool of tile buttons. Tapping a tile fills the next empty slot;
/// tapping a filled slot returns its tile to the pool. Backspace
/// undoes the most recent fill, refresh wipes the card.
///
/// When every slot on the current card matches its answer, the card
/// celebrates briefly then auto-advances to the next one. After the
/// final card lands the lesson auto-completes — no extra "Next"
/// click required.
///
/// Watch port note: the data shape (`MicroPuzzleCard` with
/// pre-rendered `lineHtml`) and the bank-of-tiles interaction model
/// are deliberately portable. A SwiftUI rewrite renders the same
/// HTML into a WKWebView (or its own SwiftUI tokenizer), and the
/// state transitions are a tiny finite-state machine: tile-tap,
/// slot-tap, backspace, reset.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { codeToHtml } from "shiki";
import type { LanguageId, MicroPuzzleCard, ClozeSlot } from "../data/types";
import { Icon } from "@base/primitives/icon";
import { rotateCcw } from "@base/primitives/icon/icons/rotate-ccw";
import { iconDelete as deleteIcon } from "@base/primitives/icon/icons/delete";
import { check as checkIcon } from "@base/primitives/icon/icons/check";
import "./MobileMicroPuzzle.css";

interface Props {
  challenges: MicroPuzzleCard[];
  language: LanguageId;
  /// Optional intro narration (Markdown-free; rendered as plain text
  /// above the first card). The deck-progress / hint stays in-card.
  prompt?: string;
  /// Pre-mark every card as solved when the parent says the lesson
  /// is already complete. Lets a re-visit show all answers without
  /// forcing the learner to redo the work.
  isCompleted?: boolean;
  /// Fired when the LAST card in the deck is solved on a fresh visit
  /// (i.e. not a revisit). The lesson dispatch wires this to its
  /// onComplete so finishing the deck auto-marks the lesson complete
  /// + advances to the next lesson — same auto-advance feel as
  /// quizzes finishing on a correct answer.
  onComplete?: () => void;
}

const SLOT_RE = /__SLOT_([A-Za-z0-9_-]+)__/g;
const THEME = "github-dark";

/// Map our LanguageId to a Shiki language id. Most match 1:1; a few
/// need explicit aliasing where Shiki's name differs from ours.
function shikiLang(language: LanguageId): string {
  switch (language) {
    case "reactnative":
      return "tsx";
    case "threejs":
      return "javascript";
    case "vyper":
      return "python";
    case "bun":
      return "typescript";
    case "assembly":
      return "asm";
    default:
      return language;
  }
}

export default function MobileMicroPuzzle({
  challenges,
  language,
  prompt,
  isCompleted,
  onComplete,
}: Props) {
  // The deck walks one card at a time. `step` is the active index;
  // it advances on solve (with a brief celebration) or on tap of the
  // bottom-of-bank "skip" arrow when shown. We don't unmount the
  // previous card — instead we rely on `key={card.id}` so the next
  // card mounts fresh and doesn't inherit the previous one's state.
  const [step, setStep] = useState(0);
  // Reset the deck pointer when the parent passes a new set of
  // challenges (lesson change). The Card's `key={card.id}` already
  // wipes per-card state; this just keeps the progress bar honest.
  useEffect(() => {
    setStep(0);
  }, [challenges]);

  if (challenges.length === 0) {
    return (
      <section className="m-mp">
        <p className="m-mp__empty">No drills available for this lesson.</p>
      </section>
    );
  }
  const card = challenges[Math.min(step, challenges.length - 1)];
  const last = step >= challenges.length - 1;

  return (
    <section className="m-mp" aria-label="Code drill">
      {prompt && <p className="m-mp__prompt">{prompt}</p>}
      <DeckProgress step={step} total={challenges.length} />
      <Card
        key={card.id}
        card={card}
        language={language}
        index={step}
        total={challenges.length}
        isCompleted={isCompleted}
        onSolved={() => {
          if (last) {
            // Last card just landed. Fire the lesson's
            // `onComplete` so the dispatch marks complete +
            // advances — but only on a fresh visit (revisits
            // start with every card pre-solved and shouldn't
            // ricochet the learner forward without input).
            if (!isCompleted && onComplete) {
              window.setTimeout(() => onComplete(), 600);
            }
            return;
          }
          // Mid-deck — celebrate-then-advance. The 600ms beat
          // is the sweet spot: long enough that the learner
          // sees the green chip + explanation, short enough
          // not to break flow when drilling fast.
          window.setTimeout(() => setStep((s) => s + 1), 600);
        }}
      />
    </section>
  );
}

/// Top-of-deck progress bar. The bar is the only "where am I" cue —
/// the bottom of the screen is owned by the wordbank, so a heavy
/// breadcrumb up top would crowd the code. One thin filled bar plus
/// the `${step+1}/${total}` label is plenty.
function DeckProgress({ step, total }: { step: number; total: number }) {
  const pct = total > 0 ? Math.round(((step + 1) / total) * 100) : 0;
  return (
    <div className="m-mp__deck-progress" aria-hidden>
      <span className="m-mp__deck-step">
        {step + 1}/{total}
      </span>
      <div className="m-mp__deck-bar">
        <div className="m-mp__deck-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/// Per-card state machine. Each tile in the wordbank has a stable
/// index; we track which indices are consumed (used) and a fill map
/// from slot id → consumed-tile index. `history` is the stack of
/// slot ids in fill order, so backspace pops the most recent.
interface CardState {
  /// Which tile index (if any) is currently sitting in each slot.
  fills: Record<string, number | null>;
  /// Slot ids in order of fill. Top of the stack pops on backspace.
  history: string[];
}

type CardAction =
  | { type: "fill"; slotId: string; tileIdx: number }
  | { type: "clear"; slotId: string }
  | { type: "backspace" }
  | { type: "reset"; slotIds: string[] };

function cardReducer(state: CardState, action: CardAction): CardState {
  switch (action.type) {
    case "fill": {
      // If the slot was already filled, free its tile first so the
      // user can swap content without leaking a tile out of the
      // pool.
      const next = { ...state.fills };
      const nextHistory = state.history.filter((id) => id !== action.slotId);
      next[action.slotId] = action.tileIdx;
      nextHistory.push(action.slotId);
      return { fills: next, history: nextHistory };
    }
    case "clear": {
      if (state.fills[action.slotId] == null) return state;
      const next = { ...state.fills, [action.slotId]: null };
      return {
        fills: next,
        history: state.history.filter((id) => id !== action.slotId),
      };
    }
    case "backspace": {
      if (state.history.length === 0) return state;
      const last = state.history[state.history.length - 1];
      const next = { ...state.fills, [last]: null };
      return { fills: next, history: state.history.slice(0, -1) };
    }
    case "reset": {
      const cleared: Record<string, number | null> = {};
      for (const id of action.slotIds) cleared[id] = null;
      return { fills: cleared, history: [] };
    }
  }
}

/// One puzzle card with its own wordbank. The card content is the
/// code block + optional hint / explanation; the bank lives in the
/// same component because the two surfaces share state and remount
/// together when the parent advances.
function Card({
  card,
  language,
  index,
  total,
  isCompleted,
  onSolved,
}: {
  card: MicroPuzzleCard;
  language: LanguageId;
  index: number;
  total: number;
  isCompleted?: boolean;
  onSolved: () => void;
}) {
  // Build the wordbank pool from the card's blanks. Strategy:
  //   - One tile per blank for the answer (so the pool always
  //     contains a winning fill set).
  //   - Plus the union of distractors across all blanks — capped so
  //     the bank doesn't balloon to 20 tiles on a 5-blank card.
  // Tile indices are unique even when labels duplicate (`+` × 3),
  // so consumed-tile tracking stays accurate when the same token
  // appears in multiple slots.
  const pool: PoolTile[] = useMemo(() => buildPool(card), [card]);

  // Initial state. When `isCompleted` is true (re-visit), pre-fill
  // every slot with its correct answer so the screen reads "you
  // nailed this" at a glance. We map each answer to the FIRST
  // matching tile index in the shuffled pool.
  const initial: CardState = useMemo(() => {
    const fills: Record<string, number | null> = {};
    const history: string[] = [];
    if (isCompleted) {
      const used = new Set<number>();
      for (const blank of card.blanks) {
        const tileIdx = pool.findIndex(
          (t) => t.label === blank.answer && !used.has(t.idx),
        );
        if (tileIdx !== -1) {
          fills[blank.id] = pool[tileIdx].idx;
          used.add(pool[tileIdx].idx);
          history.push(blank.id);
        } else {
          fills[blank.id] = null;
        }
      }
    } else {
      for (const blank of card.blanks) fills[blank.id] = null;
    }
    return { fills, history };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, isCompleted, pool]);

  const [state, dispatch] = useReducer(cardReducer, initial);

  // Pre-render the line via Shiki on first mount, falling back to
  // runtime rendering if the build pipeline didn't bake `lineHtml`.
  // The output has `<span data-mp-slot="...">` placeholders that
  // we'll mutate per-render to show the current fill (or empty box).
  const [renderedHtml, setRenderedHtml] = useState<string | null>(
    card.lineHtml ?? null,
  );
  useEffect(() => {
    if (card.lineHtml) {
      setRenderedHtml(card.lineHtml);
      return;
    }
    let cancelled = false;
    void renderLine(card.line, language).then((html) => {
      if (!cancelled) setRenderedHtml(html);
    });
    return () => {
      cancelled = true;
    };
  }, [card.line, card.lineHtml, language]);

  // Resolve fill labels for the current state — each slot is either
  // empty, holding the correct token, or holding a wrong token. The
  // PuzzleLine component reads this map to set the inline slot
  // class names + textContent.
  const slotPick: Record<string, string | null> = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const blank of card.blanks) {
      const tileIdx = state.fills[blank.id];
      if (tileIdx == null) {
        out[blank.id] = null;
      } else {
        const tile = pool.find((t) => t.idx === tileIdx);
        out[blank.id] = tile?.label ?? null;
      }
    }
    return out;
  }, [state.fills, pool, card.blanks]);

  // All slots correct? Auto-fire the parent's onSolved once. Latch
  // so a backspace-then-refill doesn't re-fire. On a re-visit
  // (`isCompleted` true) we initialize `fired=true` so the effect
  // short-circuits — otherwise every card would auto-cascade
  // forward and the user couldn't browse a completed deck.
  const correctCount = card.blanks.filter(
    (b) => slotPick[b.id] === b.answer,
  ).length;
  const allCorrect =
    correctCount === card.blanks.length && card.blanks.length > 0;
  const fired = useRef(Boolean(isCompleted));
  useEffect(() => {
    if (!allCorrect) return;
    if (fired.current) return;
    fired.current = true;
    onSolved();
  }, [allCorrect, onSolved]);

  const usedTileIdxs = useMemo<Set<number>>(() => {
    const out = new Set<number>();
    for (const id of card.blanks.map((b) => b.id)) {
      const idx = state.fills[id];
      if (idx != null) out.add(idx);
    }
    return out;
  }, [state.fills, card.blanks]);

  // Tap a pool tile → fill the next empty slot in card-blank order,
  // OR if the user previously tapped a filled slot to "select" it,
  // overwrite that slot. We don't ship the slot-selection UX yet
  // (next-empty is the simpler, faster default), but the reducer
  // handles `fill` against an already-filled slot correctly so we
  // can wire selection later without refactoring state.
  const tapTile = (tile: PoolTile) => {
    if (usedTileIdxs.has(tile.idx)) return;
    if (allCorrect) return;
    const nextEmpty = card.blanks.find((b) => state.fills[b.id] == null);
    if (!nextEmpty) return;
    dispatch({ type: "fill", slotId: nextEmpty.id, tileIdx: tile.idx });
  };

  const tapSlot = (slotId: string) => {
    if (allCorrect) return;
    dispatch({ type: "clear", slotId });
  };

  return (
    <article className="m-mp__card" data-card-index={index} aria-live="polite">
      <div className="m-mp__card-content">
        <header className="m-mp__card-head">
          <span className="m-mp__card-step">
            Card {index + 1}/{total}
          </span>
          {card.hint && <span className="m-mp__card-hint">{card.hint}</span>}
        </header>

        <div
          className={
            "m-mp__line" +
            (allCorrect ? " m-mp__line--solved" : "")
          }
        >
          {renderedHtml === null ? (
            <pre className="m-mp__line-raw">
              <code>{card.line.replace(SLOT_RE, "____")}</code>
            </pre>
          ) : (
            <PuzzleLine
              html={renderedHtml}
              blanks={card.blanks}
              picks={slotPick}
              onTapSlot={tapSlot}
            />
          )}
        </div>

        {allCorrect && card.explanation && (
          <p className="m-mp__explanation">
            <Icon icon={checkIcon} size="sm" color="currentColor" />
            <span>{card.explanation}</span>
          </p>
        )}
      </div>

      {/* Word bank — sticky to the bottom of the card area. Toolbar
          on top with backspace + reset, then the grid of tiles. The
          grid wraps so the row count flexes with pool size. */}
      <footer className="m-mp__bank" aria-label="Word bank">
        <div className="m-mp__bank-tools">
          <span className="m-mp__bank-counter">
            {usedTileIdxs.size}/{card.blanks.length}
          </span>
          <div className="m-mp__bank-tools-spacer" />
          <button
            type="button"
            className="m-mp__bank-btn"
            onClick={() => dispatch({ type: "reset", slotIds: card.blanks.map((b) => b.id) })}
            aria-label="Reset card"
            disabled={usedTileIdxs.size === 0 || allCorrect}
          >
            <Icon icon={rotateCcw} size="sm" color="currentColor" />
          </button>
          <button
            type="button"
            className="m-mp__bank-btn"
            onClick={() => dispatch({ type: "backspace" })}
            aria-label="Backspace last fill"
            disabled={state.history.length === 0 || allCorrect}
          >
            <Icon icon={deleteIcon} size="sm" color="currentColor" />
          </button>
        </div>
        <div className="m-mp__bank-grid" role="list">
          {pool.map((tile) => {
            const used = usedTileIdxs.has(tile.idx);
            return (
              <button
                key={tile.idx}
                type="button"
                role="listitem"
                className={
                  "m-mp__tile" + (used ? " m-mp__tile--used" : "")
                }
                onClick={() => tapTile(tile)}
                disabled={used || allCorrect}
                aria-label={`Tile ${tile.label}`}
              >
                <code>{tile.label}</code>
              </button>
            );
          })}
        </div>
      </footer>
    </article>
  );
}

/// Inline-renders the Shiki-highlighted HTML, intercepting the slot
/// placeholder spans and replacing their textContent + classes per
/// fill state. Re-binds the click handler so tapping a filled slot
/// returns its tile to the pool.
function PuzzleLine({
  html,
  blanks,
  picks,
  onTapSlot,
}: {
  html: string;
  blanks: ClozeSlot[];
  picks: Record<string, string | null>;
  onTapSlot: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const blank of blanks) {
      const node = root.querySelector<HTMLElement>(
        `[data-mp-slot="${blank.id}"]`,
      );
      if (!node) continue;
      const pick = picks[blank.id] ?? null;
      const isCorrect = pick === blank.answer;
      const isWrong = pick !== null && !isCorrect;
      // Empty slots show as a ghosted box — taller than the chip
      // version, to read as "drop something here" instead of "tap
      // me for options". Filled slots show their token in a solid
      // chip styled to match the card type.
      node.textContent = pick ?? "\u00A0\u00A0\u00A0";
      node.className =
        "m-mp__slot" +
        (pick === null ? " m-mp__slot--empty" : "") +
        (isCorrect ? " m-mp__slot--correct" : "") +
        (isWrong ? " m-mp__slot--wrong" : "");
      node.onclick = (e) => {
        e.preventDefault();
        if (pick !== null) onTapSlot(blank.id);
      };
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", pick === null ? "-1" : "0");
    }
  }, [blanks, picks, onTapSlot]);
  return (
    <div
      ref={ref}
      className="m-mp__line-html"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface PoolTile {
  /// Stable identity within the card. Multiple tiles can share a
  /// label (e.g. three `+` tiles) but their `idx` is always unique
  /// so used-tile tracking doesn't false-positive.
  idx: number;
  label: string;
}

/// Build the wordbank for a card. Includes one tile per blank's
/// answer plus a capped set of distractors. Stable shuffle (seeded
/// by card.id) so a re-mount with the same card keeps the same
/// tile order — important because the user is mid-thought when
/// React re-renders.
function buildPool(card: MicroPuzzleCard): PoolTile[] {
  const tiles: PoolTile[] = [];
  let i = 0;
  // Always include every answer (even when an answer is repeated
  // across multiple blanks — each gets its own tile).
  for (const blank of card.blanks) {
    tiles.push({ idx: i++, label: blank.answer });
  }
  // Distractors. We pull up to two per blank, deduped against the
  // answer set so the pool isn't packed with redundant tokens. The
  // "answer set" is per-occurrence — a `+` answer in one slot
  // doesn't preclude `+` showing up as a distractor for another
  // slot if the author intended it.
  const seenLabels = new Set(card.blanks.map((b) => b.answer));
  for (const blank of card.blanks) {
    let added = 0;
    for (const opt of blank.options) {
      if (added >= 2) break;
      if (seenLabels.has(opt)) continue;
      tiles.push({ idx: i++, label: opt });
      seenLabels.add(opt);
      added += 1;
    }
  }
  // Stable shuffle.
  return shuffleSeeded(tiles, card.id);
}

/// Seeded Fisher-Yates so two renders of the same card yield the
/// same tile order. Seed comes from card.id (hashed) so re-shuffling
/// per-render is impossible.
function shuffleSeeded<T>(arr: T[], seedStr: string): T[] {
  const out = [...arr];
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) {
    seed = (seed * 31 + seedStr.charCodeAt(i)) | 0;
  }
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/// Run Shiki against a line of code, replacing slot markers with
/// `<span data-mp-slot="...">` placeholders BEFORE highlighting so
/// the placeholders end up inside the rendered token stream.
async function renderLine(line: string, language: LanguageId): Promise<string> {
  const slotIds: string[] = [];
  const sentinel = (idx: number) => `__FBSLOT${idx}__`;
  let prepared = line.replace(SLOT_RE, (_m, id) => {
    const idx = slotIds.length;
    slotIds.push(id);
    return sentinel(idx);
  });
  let html: string;
  try {
    html = await codeToHtml(prepared, {
      lang: shikiLang(language),
      theme: THEME,
      transformers: [],
    });
  } catch {
    html = `<pre><code>${escapeHtml(prepared)}</code></pre>`;
  }
  for (let i = 0; i < slotIds.length; i++) {
    const span = `<span data-mp-slot="${slotIds[i]}" class="m-mp__slot m-mp__slot--empty"></span>`;
    html = html.replace(sentinel(i), span);
  }
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
