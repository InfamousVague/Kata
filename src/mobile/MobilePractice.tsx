/// Mobile Practice tab. A spaced-repetition-ish drill surface that
/// pulls random `MicroPuzzleCard`s from every course the learner has
/// touched, filtered by language. Think codecademy "review" — quick
/// hits across the topics you've actually started, not a full course
/// re-read.
///
/// The deck is built fresh on each tab open: we walk every course's
/// lessons, collect cards from `MicroPuzzleLesson` entries, and
/// shuffle. The user can:
///   - Pick a language pill at the top (defaults to "all covered")
///   - Tap "Shuffle" to draw a new deck of ~15 cards
///   - Solve cards one at a time; auto-scroll to the next on correct
///
/// "Covered" = the user has at least one completion in that language's
/// courses. New learners see all available languages until their
/// completion history kicks in. The bar isn't strict — it's a sane
/// default that prioritises practice over discovery.
///
/// Reuses the existing `MicroPuzzleCard` rendering by constructing a
/// synthetic stack and passing it into `MobileMicroPuzzle`. The cards
/// retain their original `language` so highlighting picks the right
/// Shiki grammar per row, even when the deck mixes languages.

import { useEffect, useMemo, useState } from "react";
import type {
  Course,
  LanguageId,
  MicroPuzzleCard,
  MicroPuzzleLesson,
} from "../data/types";
import { isMicroPuzzle } from "../data/types";
import { Icon } from "@base/primitives/icon";
import { dumbbell } from "@base/primitives/icon/icons/dumbbell";
import { shuffle as shuffleIcon } from "@base/primitives/icon/icons/shuffle";
import MobileMicroPuzzle from "./MobileMicroPuzzle";
import "./MobilePractice.css";

interface Props {
  courses: Course[];
  /// Completion set keyed `${courseId}:${lessonId}` (same shape the
  /// rest of the mobile UI uses). Drives "covered" language detection.
  completed: Set<string>;
}

/// One card in the practice deck. Carries the source language so the
/// renderer picks the right Shiki grammar — without this, a Python
/// drill would highlight as JS if the deck happens to be primarily JS.
interface DeckCard {
  card: MicroPuzzleCard;
  language: LanguageId;
  /// Course title, shown as a tiny badge above the card so the
  /// learner sees where this drill came from.
  courseTitle: string;
}

const DECK_SIZE = 15;

const LANG_LABELS: Partial<Record<LanguageId, string>> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  reactnative: "React Native",
  svelte: "Svelte",
  solid: "Solid",
  htmx: "HTMX",
  astro: "Astro",
  bun: "Bun",
  solidity: "Solidity",
  vyper: "Vyper",
  c: "C",
  cpp: "C++",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  swift: "Swift",
  assembly: "Assembly",
  threejs: "Three.js",
};

function labelFor(id: LanguageId): string {
  return LANG_LABELS[id] ?? id;
}

export default function MobilePractice({ courses, completed }: Props) {
  // Every micropuzzle card across every course, with its source
  // language attached so the renderer can highlight per row.
  const allCards = useMemo<DeckCard[]>(() => {
    const out: DeckCard[] = [];
    for (const c of courses) {
      for (const ch of c.chapters) {
        for (const lesson of ch.lessons) {
          if (!isMicroPuzzle(lesson)) continue;
          const mp = lesson as MicroPuzzleLesson;
          for (const card of mp.challenges) {
            // Skip degenerate zero-blank "context" cards — they don't
            // exercise anything in practice mode.
            if (!card.blanks || card.blanks.length === 0) continue;
            out.push({
              card,
              language: mp.language,
              courseTitle: c.title,
            });
          }
        }
      }
    }
    return out;
  }, [courses]);

  // Languages the learner has touched (any completion in a course of
  // that language). Empty set on first visit → fall back to "every
  // language with cards".
  const coveredLangs = useMemo<Set<LanguageId>>(() => {
    const out = new Set<LanguageId>();
    for (const c of courses) {
      const hasCompletion = c.chapters.some((ch) =>
        ch.lessons.some((l) => completed.has(`${c.id}:${l.id}`)),
      );
      if (hasCompletion) out.add(c.language);
    }
    return out;
  }, [courses, completed]);

  // Languages that actually have cards available. Practice pills only
  // surface what the learner can actually drill on.
  const availableLangs = useMemo<LanguageId[]>(() => {
    const seen = new Set<LanguageId>();
    for (const c of allCards) seen.add(c.language);
    return Array.from(seen);
  }, [allCards]);

  // The default pick: "all covered" if the user has any completions,
  // otherwise "all" — new users still get a deck.
  const [filter, setFilter] = useState<"covered" | "all" | LanguageId>(
    "covered",
  );
  // A nonce that bumps every time the user taps Shuffle. Used as a
  // useMemo dep so the deck re-shuffles deterministically per click
  // rather than every parent render.
  const [shuffleNonce, setShuffleNonce] = useState(0);

  // Filter the card pool by the active language pill, then shuffle and
  // take DECK_SIZE.
  const deck = useMemo<DeckCard[]>(() => {
    let pool: DeckCard[];
    if (filter === "all") {
      pool = allCards;
    } else if (filter === "covered") {
      // Fall back to "all" for fresh accounts so the tab still has
      // something on first launch.
      pool = coveredLangs.size > 0
        ? allCards.filter((c) => coveredLangs.has(c.language))
        : allCards;
    } else {
      pool = allCards.filter((c) => c.language === filter);
    }
    const out = [...pool];
    // Fisher-Yates. We seed with shuffleNonce so calling-this-twice
    // with the same nonce returns the same deck (helps when React
    // re-runs useMemo on prop equality).
    let seed = shuffleNonce * 9301 + 49297;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.slice(0, DECK_SIZE);
    // shuffleNonce intentionally part of deps — that's the whole
    // point of the re-shuffle button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, allCards, coveredLangs, shuffleNonce]);

  // Reset the implicit MicroPuzzle render when the deck changes —
  // remounting via a stable key tied to filter+nonce so card-level
  // state (which option each chip is on) clears on shuffle / tab
  // switch. Same trick MobileLesson uses to wipe puzzle state on
  // lesson nav.
  const deckKey = `${filter}::${shuffleNonce}`;

  // If the user has never touched anything AND there are no cards
  // available at all (e.g. fresh install with the courses still
  // hydrating), render an empty-state so the screen isn't blank.
  const hasAnyCards = allCards.length > 0;

  // Pre-compute per-language card counts for the pill badges so the
  // user sees at a glance where the drill weight is.
  const cardsByLang = useMemo<Map<LanguageId, number>>(() => {
    const m = new Map<LanguageId, number>();
    for (const c of allCards) m.set(c.language, (m.get(c.language) ?? 0) + 1);
    return m;
  }, [allCards]);

  // When availableLangs changes (e.g. courses finish hydrating), make
  // sure the active filter is still valid. Falling back to "covered"
  // is safe — the deck builder handles the empty-set case.
  useEffect(() => {
    if (
      filter !== "covered" &&
      filter !== "all" &&
      !availableLangs.includes(filter)
    ) {
      setFilter("covered");
    }
  }, [availableLangs, filter]);

  return (
    <div className="m-prac">
      <header className="m-prac__head">
        <div className="m-prac__head-text">
          <h1 className="m-prac__title">
            <Icon icon={dumbbell} size="sm" color="currentColor" />
            <span>Practice</span>
          </h1>
          <p className="m-prac__subtitle">
            {coveredLangs.size > 0
              ? `Random drills from ${coveredLangs.size} language${coveredLangs.size === 1 ? "" : "s"} you've touched.`
              : "Random drills across the catalog. Open a course to focus your practice on what you're learning."}
          </p>
        </div>
        <button
          type="button"
          className="m-prac__shuffle"
          onClick={() => setShuffleNonce((n) => n + 1)}
          aria-label="Shuffle the deck"
          disabled={!hasAnyCards || deck.length === 0}
        >
          <Icon icon={shuffleIcon} size="sm" color="currentColor" />
        </button>
      </header>

      {hasAnyCards && availableLangs.length > 1 && (
        <nav
          className="m-prac__filter"
          role="tablist"
          aria-label="Filter by language"
        >
          {/* "Covered" is the default — anything the learner has
              touched. Always shown if they have completions. */}
          {coveredLangs.size > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={filter === "covered"}
              className={`m-prac__pill${filter === "covered" ? " m-prac__pill--active" : ""}`}
              onClick={() => setFilter("covered")}
            >
              Covered
              <span className="m-prac__pill-count">{coveredLangs.size}</span>
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={`m-prac__pill${filter === "all" ? " m-prac__pill--active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All
            <span className="m-prac__pill-count">{allCards.length}</span>
          </button>
          {availableLangs.map((lang) => (
            <button
              key={lang}
              type="button"
              role="tab"
              aria-selected={filter === lang}
              className={`m-prac__pill${filter === lang ? " m-prac__pill--active" : ""}`}
              onClick={() => setFilter(lang)}
            >
              {labelFor(lang)}
              <span className="m-prac__pill-count">
                {cardsByLang.get(lang) ?? 0}
              </span>
            </button>
          ))}
        </nav>
      )}

      {!hasAnyCards && (
        <p className="m-prac__empty">
          No drills available yet. Once you launch the app on a fresh
          install (or the seed refresh runs on next launch), the
          Practice tab will fill with cards from across the catalog.
        </p>
      )}

      {hasAnyCards && deck.length === 0 && (
        <p className="m-prac__empty">
          No drills match this filter. Try "All" or pick a different
          language.
        </p>
      )}

      {deck.length > 0 && (
        // The MicroPuzzle renderer expects a single `language` for the
        // whole deck (Shiki theme + grammar). When the deck mixes
        // languages we group consecutive same-language runs and render
        // them as separate sub-decks so each row's syntax highlighting
        // is correct. Each sub-deck remounts on shuffle via the
        // composite key.
        <MultiLangDeck deck={deck} keyHint={deckKey} />
      )}
    </div>
  );
}

/// Helper: render a deck that may contain cards from different
/// languages. We segment by run-length so a Python card renders with
/// the Python grammar even when surrounded by JS cards. Each segment
/// is its own `<MobileMicroPuzzle>` block; the visual gap between
/// them is small enough that the user reads it as one continuous
/// stack.
function MultiLangDeck({ deck, keyHint }: { deck: DeckCard[]; keyHint: string }) {
  const segments = useMemo(() => {
    const out: Array<{ language: LanguageId; cards: MicroPuzzleCard[]; courseTitles: string[] }> = [];
    for (const dc of deck) {
      const last = out[out.length - 1];
      if (last && last.language === dc.language) {
        last.cards.push(dc.card);
        last.courseTitles.push(dc.courseTitle);
      } else {
        out.push({
          language: dc.language,
          cards: [dc.card],
          courseTitles: [dc.courseTitle],
        });
      }
    }
    return out;
  }, [deck]);

  return (
    <div className="m-prac__deck">
      {segments.map((seg, i) => (
        <MobileMicroPuzzle
          key={`${keyHint}::${i}::${seg.language}`}
          challenges={seg.cards}
          language={seg.language}
          prompt={undefined}
        />
      ))}
    </div>
  );
}
