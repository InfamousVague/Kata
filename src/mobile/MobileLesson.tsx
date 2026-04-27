/// Mobile lesson router. Inspects `lesson.kind` and dispatches to the
/// right specialised view:
///   - reading          → <MobileReader />
///   - quiz             → <MobileQuiz />
///   - puzzle           → <MobilePuzzle />
///   - exercise / mixed → <MobilePuzzle /> (synthesise blocks from
///                                          `solution` on the fly)
///
/// The header (back arrow + course title + chapter label) is shared
/// across all three so navigation feels uniform.

import { useState } from "react";
import type { Course, Lesson, PuzzleBlock } from "../data/types";
import { isExerciseKind, isPuzzle, isQuiz } from "../data/types";
import MobileReader from "./MobileReader";
import MobileQuiz from "./MobileQuiz";
import MobilePuzzle from "./MobilePuzzle";
import MobileOutline from "./MobileOutline";
import { Icon } from "@base/primitives/icon";
import { chevronLeft } from "@base/primitives/icon/icons/chevron-left";
import { chevronRight } from "@base/primitives/icon/icons/chevron-right";
import { listTree } from "@base/primitives/icon/icons/list-tree";
import "./MobileLesson.css";

interface Props {
  course: Course;
  chapterIndex: number;
  lessonIndex: number;
  lesson: Lesson;
  completed: Set<string>;
  onBack: () => void;
  onComplete: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onJump: (chapterIndex: number, lessonIndex: number) => void;
  isCompleted: boolean;
}

/// Synthesise puzzle blocks from an exercise's `solution` string.
/// Splits on non-empty lines, keeping comments + blank-line groupings
/// rough — fine for the tap-to-arrange puzzle UX which is testing
/// "do you know what shape the solution has", not whitespace pedantry.
function blocksFromSolution(solution: string): {
  blocks: PuzzleBlock[];
  solutionOrder: string[];
} {
  const lines = solution.split("\n");
  const blocks: PuzzleBlock[] = [];
  const solutionOrder: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const code = buf.join("\n");
    const id = `b${blocks.length}`;
    blocks.push({ id, code });
    solutionOrder.push(id);
    buf = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      // Blank line ends the current block (statement boundary).
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return { blocks, solutionOrder };
}

export default function MobileLesson({
  course,
  chapterIndex,
  lessonIndex,
  lesson,
  completed,
  onBack,
  onComplete,
  onPrev,
  onNext,
  onJump,
  isCompleted,
}: Props) {
  const chapter = course.chapters[chapterIndex];
  const [outlineOpen, setOutlineOpen] = useState(false);

  // Where in the course are we, in 1-indexed flat position? Drives the
  // header progress chip ("Lesson 7 of 56").
  let lessonNumber = 0;
  let totalLessons = 0;
  for (let ci = 0; ci < course.chapters.length; ci++) {
    for (let li = 0; li < course.chapters[ci].lessons.length; li++) {
      totalLessons += 1;
      if (ci < chapterIndex || (ci === chapterIndex && li <= lessonIndex)) {
        lessonNumber = totalLessons;
      }
    }
  }

  return (
    <div className="m-lesson">
      <header className="m-lesson__head">
        <button
          type="button"
          className="m-lesson__back"
          onClick={onBack}
          aria-label="Back to library"
        >
          <Icon icon={chevronLeft} size="lg" />
        </button>
        <div className="m-lesson__head-text">
          <span className="m-lesson__crumb">{course.title}</span>
          <span className="m-lesson__chapter">{chapter?.title}</span>
        </div>
        <button
          type="button"
          className="m-lesson__outline-btn"
          onClick={() => setOutlineOpen(true)}
          aria-label="Open course outline"
        >
          <Icon icon={listTree} size="lg" />
          <span className="m-lesson__outline-position">
            {lessonNumber}/{totalLessons}
          </span>
        </button>
      </header>

      <h1 className="m-lesson__title">{lesson.title}</h1>

      <div className="m-lesson__body">
        {isQuiz(lesson) && (
          <MobileQuiz lesson={lesson} onComplete={onComplete} />
        )}
        {isPuzzle(lesson) && (
          <MobilePuzzle
            blocks={lesson.blocks}
            solutionOrder={lesson.solutionOrder}
            prompt={lesson.prompt}
            onComplete={onComplete}
            isCompleted={isCompleted}
          />
        )}
        {isExerciseKind(lesson) && (
          (() => {
            const { blocks, solutionOrder } = blocksFromSolution(lesson.solution);
            return (
              <MobilePuzzle
                blocks={blocks}
                solutionOrder={solutionOrder}
                prompt={lesson.body}
                onComplete={onComplete}
                isCompleted={isCompleted}
              />
            );
          })()
        )}
        {lesson.kind === "reading" && (
          <MobileReader body={lesson.body} onContinue={onComplete} />
        )}
      </div>

      {(onPrev || onNext) && (
        <nav className="m-lesson__nav" aria-label="Lesson navigation">
          <button
            type="button"
            className="m-lesson__nav-btn"
            onClick={onPrev}
            disabled={!onPrev}
          >
            <Icon icon={chevronLeft} size="base" />
            <span>Previous</span>
          </button>
          <button
            type="button"
            className="m-lesson__nav-btn m-lesson__nav-btn--next"
            onClick={onNext}
            disabled={!onNext}
          >
            <span>Next</span>
            <Icon icon={chevronRight} size="base" />
          </button>
        </nav>
      )}

      {outlineOpen && (
        <MobileOutline
          course={course}
          activeChapter={chapterIndex}
          activeLesson={lessonIndex}
          completed={completed}
          onJump={onJump}
          onClose={() => setOutlineOpen(false)}
        />
      )}
    </div>
  );
}
